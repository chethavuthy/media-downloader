import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export interface DownloadedMedia {
  path: string;
  type: 'photo' | 'video';
}

/**
 * Extract Instagram shortcode from URL
 */
function getInstagramShortcode(url: string): string | null {
  // Regex to match shortcode in /p/, /reel/, /reels/, /tv/
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Scan directory recursively for media files
 */
async function scanForMedia(dir: string): Promise<DownloadedMedia[]> {
  const mediaFiles: DownloadedMedia[] = [];

  async function scan(currentDir: string) {
    if (!(await fs.stat(currentDir)).isDirectory()) return;

    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase();
        if (!ext) continue;

        const isPhoto = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
        const isVideo = ['mp4', 'webm', 'mkv', 'mov'].includes(ext);

        if (isPhoto) {
          mediaFiles.push({ path: fullPath, type: 'photo' });
        } else if (isVideo) {
          mediaFiles.push({ path: fullPath, type: 'video' });
        }
      }
    }
  }

  await scan(dir);

  // Sort by filename to maintain order
  mediaFiles.sort((a, b) => a.path.localeCompare(b.path));

  // Filter out thumbnails for videos (common with instaloader)
  const filteredFiles: DownloadedMedia[] = [];
  const videoBasenames = new Set(
    mediaFiles
      .filter(m => m.type === 'video')
      .map(m => path.basename(m.path, path.extname(m.path)))
  );

  for (const media of mediaFiles) {
    if (media.type === 'photo') {
      const basename = path.basename(media.path, path.extname(media.path));
      if (videoBasenames.has(basename)) {
        logger.info(`Skipping thumbnail photo: ${media.path}`);
        continue;
      }
    }
    filteredFiles.push(media);
  }

  return filteredFiles;
}

/**
 * Download images/videos from a post (supports albums/carousels)
 */
export async function downloadAlbum(url: string, outputDir: string): Promise<DownloadedMedia[]> {
  logger.info(`Downloading album from: ${url}`);

  try {
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Instagram: Use instaloader
    if (url.includes('instagram.com')) {
      logger.info('Using instaloader for Instagram');
      const shortcode = getInstagramShortcode(url);
      if (!shortcode) throw new Error('Invalid Instagram URL');

      const instaloaderPath = config.instaloaderPath;
      const cmd = `${instaloaderPath} --no-metadata-json --no-captions --no-compress-json --dirname-pattern="${outputDir}" -- -${shortcode}`;

      logger.info(`Executing instaloader: ${cmd}`);
      await execAsync(cmd, { timeout: 120000 });
    }
    // Facebook: Comprehensive download strategy
    else if (url.includes('facebook.com') || url.includes('fb.com')) {
      logger.info('Using gallery-dl for Facebook');

      let targetUrl = url;
      // Follow redirect for share links
      if (url.includes('/share/')) {
        try {
          const { stdout } = await execAsync(`curl -Ls -o /dev/null -w %{url_effective} "${url}"`, { timeout: 10000 });
          if (stdout.trim()) {
            targetUrl = stdout.trim();
            logger.info(`Redirected share link to: ${targetUrl}`);
          }
        } catch (e) {
          logger.warn('Failed to follow Facebook share redirect');
        }
      }

      // Convert permalink.php to cleaner post URL (gallery-dl doesn't support permalink.php directly)
      if (targetUrl.includes('permalink.php')) {
        try {
          const urlObj = new URL(targetUrl);
          const fbid = urlObj.searchParams.get('story_fbid');
          const id = urlObj.searchParams.get('id');
          if (fbid && id) {
            targetUrl = `https://www.facebook.com/${id}/posts/${fbid}`;
            logger.info(`Converted permalink to: ${targetUrl}`);
          }
        } catch (e) {
          logger.warn('Failed to convert Facebook permalink');
        }
      }

      const galleryDlPath = config.galleryDlPath;

      const cookiesArg = config.cookiesPath
        ? `--cookies "${config.cookiesPath}"`
        : '--cookies-from-browser chrome';

      // Step 1: High-Speed Probe
      logger.info('Performing high-speed probe for Facebook gallery...');
      await execAsync(
        `${galleryDlPath} "${targetUrl}" --dest "${outputDir}" ${cookiesArg} --no-mtime --write-metadata --range 1`,
        { timeout: 60000 }
      ).catch(e => logger.warn(`Probe failed, but check files: ${e.message}`));

      let files = await scanForMedia(outputDir);

      // ADVANCED FALLBACK: Timeline Scan (Now the primary recovery method)
      // If we only got 1 image but it's a known post format, reconstruction is likely needed.
      if (files.length === 1 && (targetUrl.includes('/posts/') || targetUrl.includes('fbid=') || targetUrl.includes('permalink.php') || targetUrl.includes('/photos/') || targetUrl.includes('/share/p/'))) {
        logger.info('Reconstructing gallery via Timeline Scan (High-Speed Mode)...');

        try {
          const absOutputDir = path.resolve(outputDir);
          let metaPath: string | null = null;

          async function findMeta(dir: string): Promise<void> {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (metaPath) return;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) await findMeta(fullPath);
                else if (entry.name.endsWith('.json')) {
                  metaPath = fullPath;
                  return;
                }
              }
            } catch { }
          }
          await findMeta(absOutputDir);

          if (metaPath) {
            const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
            const baseDateStr = metadata.upload_date || metadata.date;
            const baseDate = new Date(baseDateStr).getTime();
            const userIdentifier = metadata.user_id || metadata.username;

            if (userIdentifier && !isNaN(baseDate)) {
              const scanDir = path.join(outputDir, 'timeline_scan');
              await fs.mkdir(scanDir, { recursive: true });

              // range 1-20 is enough for most recent galleries and much faster
              const timelineUrl = `https://www.facebook.com/${userIdentifier}/photos/`;
              await execAsync(
                `${galleryDlPath} "${timelineUrl}" --dest "${scanDir}" --range 1-20 ${cookiesArg} --no-mtime --write-metadata`,
                { timeout: 120000 }
              );

              const scanResults = await scanForMedia(scanDir);
              logger.info(`Timeline scan found ${scanResults.length} potential images to check.`);

              // Only perform matching if it's a known gallery type (pcb. or title has "post")
              // This prevents grabbing 50 photos from a "Mobile Uploads" album side-by-side
              const isGenuineGallery = (metadata.set_id && metadata.set_id.includes('pcb.')) ||
                (metadata.title && metadata.title.toLowerCase().includes('post'));

              const matchingFiles: DownloadedMedia[] = [];

              if (isGenuineGallery) {
                logger.info('Confirmed gallery-type post. Matching timestamps...');
                for (const media of scanResults) {
                  try {
                    const itemMetaPath = `${media.path}.json`;
                    if (await fs.stat(itemMetaPath).catch(() => null)) {
                      const itemMeta = JSON.parse(await fs.readFile(itemMetaPath, 'utf-8'));
                      const itemDateStr = itemMeta.upload_date || itemMeta.date;
                      const itemDate = new Date(itemDateStr).getTime();

                      const diff = Math.abs(itemDate - baseDate);
                      // Genuine galleries have very tight timestamps (usually < 30s)
                      if (diff <= 45000) {
                        logger.info(`Matched image ${path.basename(media.path)} (diff: ${diff / 1000}s)`);
                        const newPath = path.join(outputDir, path.basename(media.path));
                        await fs.rename(media.path, newPath);
                        matchingFiles.push({ path: newPath, type: media.type });
                      }
                    }
                  } catch (e: any) {
                    logger.warn(`Failed to process item metadata: ${e.message}`);
                  }
                }
              } else {
                logger.info('Detected standard album photo (not a gallery post). Skipping reconstruction to avoid over-downloading.');
              }

              if (matchingFiles.length > 1) {
                logger.info(`Successfully reconstructed gallery with ${matchingFiles.length} images!`);
                matchingFiles.sort((a, b) => a.path.localeCompare(b.path));
                files = matchingFiles;
              } else {
                logger.info('Timeline scan did not find additional matching photos.');
              }
            } else {
              logger.warn(`Insufficient data for timeline scan: User=${userIdentifier}, Date=${baseDate}`);
            }
          } else {
            logger.warn('No metadata (.json) found in download directory, skipping timeline scan.');
          }
        } catch (scanError: any) {
          logger.error(`Timeline Scan fallback failed`, scanError);
        }
      }

      return files;
    }
    // TikTok: Use gallery-dl
    else if (url.includes('tiktok.com')) {
      logger.info('Using gallery-dl for TikTok');
      const galleryDlPath = config.galleryDlPath;
      await execAsync(
        `${galleryDlPath} "${url}" --dest "${outputDir}" --no-mtime`,
        { timeout: 120000 }
      );
    }
    // Other platforms: Use yt-dlp
    else {
      logger.info('Using yt-dlp for download');
      const outputTemplate = path.join(outputDir, '%(autonumber)s.%(ext)s');
      const ytDlpCmd = `"${config.ytDlpPath}" "${url}" -o "${outputTemplate}" --no-warnings`;
      await execAsync(ytDlpCmd, { timeout: 120000 });
    }

    // Final scan for all platforms
    const finalFiles = await scanForMedia(outputDir);

    logger.info(`Downloaded ${finalFiles.length} unique media files`);

    if (finalFiles.length === 0) {
      try { await fs.rm(outputDir, { recursive: true, force: true }); } catch { }
      throw new Error('No media files found after download');
    }

    return finalFiles;

  } catch (error: any) {
    logger.error('Album download failed', error);
    try { await fs.rm(outputDir, { recursive: true, force: true }); } catch { }
    throw new Error(`Failed to download album: ${error.message}`);
  }
}

/**
 * Check if a URL contains media (images/videos) or is an album/carousel
 */
export async function isAlbum(url: string): Promise<boolean> {
  try {
    // Instagram detection
    if (url.includes('instagram.com')) {
      if (url.includes('/reel/') || url.includes('/reels/') || url.includes('/tv/')) {
        logger.info('Detected Instagram Video (Reel/TV), will use old logic (yt-dlp)');
        return false;
      }
      const shortcode = getInstagramShortcode(url);
      if (shortcode) {
        logger.info('Detected Instagram post/album, will attempt album download');
        return true;
      }
      return false;
    }

    // Facebook detection
    if (url.includes('facebook.com') || url.includes('fb.com')) {
      // Exclude known video patterns including share links for reels/videos
      if (
        url.includes('/watch') ||
        url.includes('/reel/') ||
        url.includes('/reels/') ||
        url.includes('fb.watch') ||
        url.includes('/share/r/') ||
        url.includes('/share/v/')
      ) {
        return false;
      }
      // Include photo/share/album/post patterns
      if (url.includes('photo.php') || url.includes('permalink.php') || url.includes('/share/') || url.includes('/photos/') || url.includes('/posts/')) {
        logger.info('Detected Facebook photo/album/post, will attempt image download');
        return true;
      }
    }

    // TikTok detection
    if (url.includes('tiktok.com')) {
      try {
        const galleryDlPath = config.galleryDlPath;
        const { stdout } = await execAsync(`${galleryDlPath} "${url}" --get-urls 2>&1`, { timeout: 10000 });
        const urls = stdout.trim().split('\n').filter(line => line.startsWith('http'));
        return urls.length > 0;
      } catch {
        return false;
      }
    }

    // General detection via yt-dlp
    const { stdout: playlistCheck } = await execAsync(
      `"${config.ytDlpPath}" "${url}" --flat-playlist --print "%(playlist_count)s" --no-warnings 2>&1`,
      { timeout: 10000 }
    ).catch(() => ({ stdout: '' }));

    if (parseInt(playlistCheck.trim()) > 1) return true;

    try {
      const result = await execAsync(`"${config.ytDlpPath}" "${url}" --print "%(ext)s" 2>&1`, { timeout: 10000 });
      const output = (result.stdout + (result.stderr || '')).toLowerCase();
      if (output.includes('no video') || output.includes('there is no video')) return true;

      const ext = result.stdout.trim().toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
    } catch (error: any) {
      const errorMsg = (error.message || '' + error.stdout || '' + error.stderr || '').toLowerCase();
      return errorMsg.includes('no video') || errorMsg.includes('there is no video');
    }
  } catch {
    return false;
  }
}
