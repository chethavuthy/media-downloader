import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { spawnAsync } from '../utils/spawnAsync.js';
import fs from 'fs/promises';
import path from 'path';

export interface DownloadedMedia {
  path: string;
  type: 'photo' | 'video';
}

/**
 * Extract Instagram shortcode from URL
 */
function getInstagramShortcode(url: string): string | null {
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

      const args = [
        '--no-metadata-json',
        '--no-captions',
        '--no-compress-json',
        `--dirname-pattern=${outputDir}`,
        '--',
        `-${shortcode}`,
      ];

      logger.info(`Executing instaloader for shortcode: ${shortcode}`);
      await spawnAsync(config.instaloaderPath, args, { timeout: 120000 });
    }
    // Facebook: Direct scraping from mbasic.facebook.com
    else if (url.includes('facebook.com') || url.includes('fb.com')) {
      logger.info('Using mbasic.facebook.com scraping for Facebook photos');

      let targetUrl = url;
      let fbid = '';
      let resolvedUrl = '';
      const resolutionUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

      // Step 1: Follow redirect for share links
      if (url.includes('/share/')) {
        try {
          logger.info(`Attempting Tier 1 resolution (local curl): ${url}`);
          const { stdout } = await spawnAsync(
            'curl',
            ['-sL', '-o', '/dev/null', '-w', '%{url_effective}', '-A', resolutionUA, url],
            { timeout: 15000 }
          );

          if (stdout.trim() && !stdout.includes('/login') && stdout.trim() !== url) {
            targetUrl = stdout.trim();
            resolvedUrl = targetUrl;
            logger.info(`Resolved share link to: ${targetUrl}`);

            const storyFbidMatch = targetUrl.match(/story_fbid=(\d+)/);
            const fbidParamMatch = targetUrl.match(/fbid=(\d+)/);
            if (storyFbidMatch) {
              fbid = storyFbidMatch[1];
            } else if (fbidParamMatch) {
              fbid = fbidParamMatch[1];
            }
          } else {
            logger.warn(`Tier 1 resolution returned same URL or login wall`);
            throw new Error('Tier 1 resolution failed');
          }
        } catch (e: any) {
          logger.warn(`Tier 1 resolution failed: ${e.message}. Attempting Tier 2 (Proxy via Codetabs)...`);

          let content = '';
          try {
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
            const { stdout } = await spawnAsync('curl', ['-sL', proxyUrl], { timeout: 20000 });
            content = stdout;
          } catch (proxyError: any) {
            logger.warn(`Tier 2 (Codetabs) failed: ${proxyError.message}. Attempting Tier 3 (AllOrigins)...`);
            try {
              const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
              const { stdout: proxyJson } = await spawnAsync('curl', ['-s', proxyUrl], { timeout: 20000 });
              if (proxyJson && proxyJson.startsWith('{')) {
                const proxyData = JSON.parse(proxyJson);
                content = proxyData.contents || '';
              }
            } catch (allOriginsError: any) {
              logger.error(`Tier 3 resolution fallback failed: ${allOriginsError.message}`);
            }
          }

          if (content) {
            logger.info('Successfully fetched content via proxy. Extracting IDs...');

            const urlIdMatch = resolvedUrl.match(
              /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid|videos\/|share\/p\/|share\/v\/)([a-zA-Z0-9]+)/
            );
            if (urlIdMatch) {
              fbid = urlIdMatch[1];
              logger.info(`Extracted ID from resolved URL: ${fbid}`);
            } else {
              const storyFbidMatch = content.match(/"story_fbid":"(\d+)"/);
              const fbidMatch = content.match(/fbid=(\d+)/);
              const canonicalMatch =
                content.match(/link rel="canonical" href="([^"]+)"/) ||
                content.match(/"og:url" content="([^"]+)"/);

              if (canonicalMatch && !canonicalMatch[1].includes('/login')) {
                const canonicalUrl = canonicalMatch[1];
                logger.info(`Found canonical URL via proxy: ${canonicalUrl}`);
                if (
                  canonicalUrl.includes('/videos/') ||
                  canonicalUrl.includes('/reel/') ||
                  canonicalUrl.includes('/watch/')
                ) {
                  logger.info('Canonical URL indicates VIDEO. Aborting image download.');
                  return [];
                }
                const canonicalIdMatch = canonicalUrl.match(
                  /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/
                );
                if (canonicalIdMatch) {
                  fbid = canonicalIdMatch[1];
                  logger.info(`Extracted ID from canonical URL: ${fbid}`);
                }
              }

              if (!fbid) {
                const genericIdMatches = content.match(/(\d{15,})/g);
                if (storyFbidMatch) {
                  fbid = storyFbidMatch[1];
                } else if (fbidMatch) {
                  fbid = fbidMatch[1];
                } else if (genericIdMatches && genericIdMatches.length > 0) {
                  fbid = genericIdMatches[genericIdMatches.length - 1];
                }
              }
            }

            if (
              resolvedUrl.includes('/videos/') ||
              resolvedUrl.includes('/reel/') ||
              resolvedUrl.includes('/watch/') ||
              resolvedUrl.includes('share/v/')
            ) {
              logger.info('Resolved URL indicates VIDEO. Aborting image download.');
              return [];
            }
          }
        }
      }

      if (fbid) {
        targetUrl = `https://www.facebook.com/photo.php?fbid=${fbid}`;
        logger.info(`Reconstructed target URL: ${targetUrl}`);
      }

      if (resolvedUrl && resolvedUrl.includes('/login')) {
        logger.warn(`Discarding login-bound resolved URL`);
        resolvedUrl = '';
      }
      if (!resolvedUrl) resolvedUrl = targetUrl;

      // Extract fbid from URL if not already found
      if (!fbid) {
        const fbidMatch = targetUrl.match(
          /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/
        );
        if (fbidMatch) fbid = fbidMatch[1];
      }

      // Step 2: mbasic.facebook.com scraping
      if (fbid) {
        logger.info(`Extracted Facebook photo ID: ${fbid}`);

        try {
          const mbasicUrl =
            fbid.startsWith('pfbid') || targetUrl.includes('/posts/')
              ? `https://mbasic.facebook.com/posts/${fbid}`
              : `https://mbasic.facebook.com/photo.php?fbid=${fbid}`;

          logger.info(`Attempting mbasic scraping: ${mbasicUrl}`);
          let stdout = '';
          const modernUA =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
          const botUA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

          try {
            const result = await spawnAsync(
              'curl',
              ['-sL', '-A', modernUA, mbasicUrl],
              { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            );
            stdout = result.stdout;
          } catch (localError: any) {
            logger.warn(`mbasic local scraping failed: ${localError.message}. Attempting Tier 2 proxy...`);
            try {
              const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(mbasicUrl)}`;
              const proxyResult = await spawnAsync('curl', ['-sL', '-A', modernUA, proxyUrl], { timeout: 30000 });
              stdout = proxyResult.stdout;

              if (stdout.includes('Connectez-vous') || stdout.includes('Log In') || stdout.length < 10000) {
                logger.warn('Tier 2 returned login wall. Attempting Tier 3 (Bot UA)...');
                const botResult = await spawnAsync('curl', ['-sL', '-A', botUA, proxyUrl], { timeout: 30000 });
                stdout = botResult.stdout;
              }
            } catch (proxyError: any) {
              logger.error(`Proxy scraping failed: ${proxyError.message}`);
            }
          }

          if (!stdout) {
            logger.warn('mbasic scraping (all tiers) returned empty stdout');
          } else {
            logger.info(`mbasic scraping returned ${stdout.length} bytes`);
          }

          const extractImages = (content: string) => {
            const matches = content.match(/(?:scontent|fbcdn\.net)[^\s"<>']+/g) || [];
            const ogMatch =
              content.match(/property="og:image" content="([^"]+)"/) ||
              content.match(/"og:image" content="([^"]+)"/);

            let urls = matches
              .map(u => {
                let cleanUrl = u.replace(/&amp;/g, '&').replace(/\\\//g, '/');
                if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
                return cleanUrl;
              })
              .filter(u => {
                const hasDomain = u.includes('scontent') || u.includes('fbcdn.net');
                const lowerUrl = u.toLowerCase();
                const hasExt =
                  lowerUrl.includes('.jpg') ||
                  lowerUrl.includes('.jpeg') ||
                  lowerUrl.includes('.png') ||
                  lowerUrl.includes('.kf') ||
                  lowerUrl.includes('_nc_');
                const isStatic =
                  u.includes('rsrc.php') ||
                  u.includes('emoji.php') ||
                  u.includes('/catalog/') ||
                  u.includes('ad_') ||
                  lowerUrl.includes('t15.') ||
                  lowerUrl.includes('/t15/') ||
                  lowerUrl.includes('t16.');
                return hasDomain && hasExt && !isStatic;
              });

            if (urls.length === 0 && ogMatch) {
              urls = [ogMatch[1].replace(/&amp;/g, '&').replace(/\\\//g, '/')];
            }
            return urls;
          };

          let imageUrls = extractImages(stdout);
          logger.info(`Initial mbasic sweep found ${imageUrls.length} image URLs`);

          const isLoginWall =
            stdout.includes('Connectez-vous') ||
            stdout.includes('Log In') ||
            (stdout.length > 0 && stdout.length < 5000);

          if (imageUrls.length === 0 || isLoginWall) {
            logger.info(`mbasic failed (URLs: ${imageUrls.length}, LoginWall: ${isLoginWall}). Attempting Tier 4 (Embed Plugin)...`);
            try {
              const pluginHref = fbid
                ? `https://www.facebook.com/facebook/posts/${fbid}`
                : resolvedUrl || targetUrl;
              const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(pluginHref)}`;
              const proxyEmbedUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
              const embedResult = await spawnAsync('curl', ['-sL', '-A', modernUA, proxyEmbedUrl], { timeout: 30000 });

              if (embedResult.stdout && embedResult.stdout.length > 1000) {
                logger.info(`Embed Plugin scraping returned ${embedResult.stdout.length} bytes`);
                const embedUrls = extractImages(embedResult.stdout);
                if (embedUrls.length > 0) {
                  logger.info(`Embed Plugin rescued the download with ${embedUrls.length} images!`);
                  imageUrls = embedUrls;
                  stdout = embedResult.stdout;
                }
              }
            } catch (embedError: any) {
              logger.warn(`Embed Plugin scraping failed: ${embedError.message}`);
            }
          }

          if (
            stdout.includes('video_id') ||
            stdout.includes('"video_id"') ||
            stdout.includes('swfobject')
          ) {
            logger.info('Content indicates VIDEO. Aborting image download.');
            return [];
          }

          logger.info(`mbasic filtered to ${imageUrls.length} valid image URLs`);

          const imageGroups = new Map<string, string[]>();
          if (imageUrls.length > 0) {
            imageUrls.forEach(u => {
              const idMatch = u.match(/(\d+)_(\d+)_(\d+)_[a-z]\.jpg/);
              let contentId = 'default';
              if (idMatch) {
                contentId = idMatch[2];
              } else {
                const anyNum = u.match(/\/(\d+)_/);
                if (anyNum) contentId = anyNum[1] || 'misc';
                else contentId = 'og_image';
              }
              if (!imageGroups.has(contentId)) imageGroups.set(contentId, []);
              imageGroups.get(contentId)?.push(u);
            });
          }

          logger.info(`Found ${imageGroups.size} unique image content groups`);

          for (const [contentId, groupUrls] of imageGroups) {
            const getDimensions = (u: string) => {
              const match = u.match(/[sp](\d+)x(\d+)/);
              if (match) {
                return {
                  w: parseInt(match[1]),
                  h: parseInt(match[2]),
                  pixels: parseInt(match[1]) * parseInt(match[2]),
                };
              }
              if ((u.includes('scontent') || u.includes('fbcdn')) && !u.includes('s100x100') && !u.includes('p100x100')) {
                return { w: 9999, h: 9999, pixels: 99999999 };
              }
              return { w: 0, h: 0, pixels: 0 };
            };

            const bestUrl = groupUrls.sort((a, b) => {
              const dimA = getDimensions(a);
              const dimB = getDimensions(b);
              if (dimA.pixels !== dimB.pixels) return dimB.pixels - dimA.pixels;
              return b.length - a.length;
            })[0];

            const dims = getDimensions(bestUrl);
            logger.info(`Best variant for ID ${contentId}: ${dims.w}x${dims.h}`);

            const minDimension = 200;
            if (dims.w > 0 && (dims.w < minDimension || dims.h < minDimension)) {
              logger.info(`Skipping small image (likely profile/thumbnail) ID ${contentId}: ${dims.w}x${dims.h}`);
              continue;
            }

            if (
              bestUrl.includes('cp0_dst_jpg_p50x50') ||
              bestUrl.includes('p50x50') ||
              bestUrl.includes('s50x50')
            ) {
              continue;
            }

            const uniqueFilename =
              contentId === 'default' || contentId === 'og_image'
                ? `${fbid}.jpg`
                : `${contentId}.jpg`;
            const imagePath = path.join(outputDir, uniqueFilename);

            logger.info(`Downloading image (ID: ${contentId}): ${imagePath}`);
            const minSize = 25000;

            try {
              await spawnAsync('curl', ['-sL', '-o', imagePath, bestUrl], { timeout: 30000 });
              const stat = await fs.stat(imagePath);
              if (stat.size <= minSize) {
                logger.warn(`Downloaded file too small (${stat.size} bytes), removing: ${imagePath}`);
                await fs.unlink(imagePath).catch(() => { /* ignore */ });
              }
            } catch (dlError: any) {
              logger.warn(`Direct image download failed for ${contentId}: ${dlError.message}. Attempting weserv.nl...`);
              const proxyImageUrl = `https://images.weserv.nl/?url=${encodeURIComponent(bestUrl)}`;
              try {
                await spawnAsync('curl', ['-sL', '-o', imagePath, proxyImageUrl], { timeout: 30000 });
              } catch {
                logger.error(`Failed to download image ${contentId} via proxy too`);
              }
            }
          }
        } catch (e: any) {
          logger.warn(`mbasic scraping overall failed: ${e.message}`);
        }
      }

      let files = await scanForMedia(outputDir);

      let isLowQuality = false;
      let lowQualityFile: DownloadedMedia | null = null;

      if (files.length === 1 && files[0].type === 'photo') {
        try {
          const stats = await fs.stat(files[0].path);
          if (stats.size < 40 * 1024) {
            logger.warn(`Downloaded single image is low quality (${Math.round(stats.size / 1024)}KB). Attempting gallery-dl fallback...`);
            isLowQuality = true;
            lowQualityFile = files[0];
          }
        } catch { /* ignore */ }
      }

      // Step 3: gallery-dl fallback
      if (files.length === 0 || isLowQuality) {
        if (isLowQuality) {
          logger.info('Retrying with gallery-dl for higher resolution...');
        } else {
          logger.info('mbasic approach detected no media, using gallery-dl fallback...');
        }

        const galleryDlArgs = [targetUrl, '--dest', outputDir, '--no-mtime', '--write-metadata', '--range', '1'];
        if (config.cookiesPath) {
          galleryDlArgs.push('--cookies', config.cookiesPath);
        }

        try {
          await spawnAsync(config.galleryDlPath, galleryDlArgs, { timeout: 60000 });
        } catch (e: any) {
          logger.warn(`gallery-dl fallback failed: ${e.message}`);
        }

        const newFiles = await scanForMedia(outputDir);
        if (newFiles.length > 0) {
          if (isLowQuality && lowQualityFile && newFiles.length === 1 && newFiles[0].path === lowQualityFile.path) {
            logger.warn('Gallery-dl did not improve quality. Returning original/low-res version.');
          } else if (isLowQuality) {
            logger.info('Gallery-dl succeeded or added files!');
          }
          files = newFiles;
        } else if (isLowQuality && lowQualityFile) {
          logger.warn('Gallery-dl returned no files. Falling back to original low-res download.');
          files = [lowQualityFile];
        }
      }

      // ADVANCED FALLBACK: Timeline Scan
      if (
        files.length === 1 &&
        (targetUrl.includes('/posts/') ||
          targetUrl.includes('fbid=') ||
          targetUrl.includes('permalink.php') ||
          targetUrl.includes('/photos/') ||
          targetUrl.includes('/share/p/'))
      ) {
        logger.info('Reconstructing gallery via Timeline Scan...');
        try {
          const absOutputDir = path.resolve(outputDir);
          let metaPath: string | null = null;

          const findMeta = async (dir: string): Promise<void> => {
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
            } catch { /* ignore */ }
          };
          await findMeta(absOutputDir);

          if (metaPath) {
            const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
            const baseDateStr = metadata.upload_date || metadata.date;
            const baseDate = new Date(baseDateStr).getTime();
            const userIdentifier = metadata.user_id || metadata.username;

            if (userIdentifier && !isNaN(baseDate)) {
              const scanDir = path.join(outputDir, 'timeline_scan');
              await fs.mkdir(scanDir, { recursive: true });

              const timelineUrl = `https://www.facebook.com/${userIdentifier}/photos/`;
              const timelineArgs = [timelineUrl, '--dest', scanDir, '--range', '1-20', '--no-mtime', '--write-metadata'];
              if (config.cookiesPath) timelineArgs.push('--cookies', config.cookiesPath);

              await spawnAsync(config.galleryDlPath, timelineArgs, { timeout: 120000 });

              const scanResults = await scanForMedia(scanDir);
              logger.info(`Timeline scan found ${scanResults.length} potential images`);

              const isGenuineGallery =
                (metadata.set_id && metadata.set_id.includes('pcb.')) ||
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
                logger.info('Standard album photo — skipping reconstruction.');
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
            logger.warn('No metadata (.json) found, skipping timeline scan.');
          }
        } catch (scanError: any) {
          logger.error('Timeline Scan fallback failed', scanError);
        }
      }

      return files;
    }
    // TikTok: Use gallery-dl
    else if (url.includes('tiktok.com')) {
      logger.info('Using gallery-dl for TikTok');
      await spawnAsync(
        config.galleryDlPath,
        [url, '--dest', outputDir, '--no-mtime'],
        { timeout: 120000 }
      );
    }
    // Other platforms: Use yt-dlp
    else {
      logger.info('Using yt-dlp for download');
      const outputTemplate = path.join(outputDir, '%(autonumber)s.%(ext)s');
      await spawnAsync(
        config.ytDlpPath,
        [url, '-o', outputTemplate, '--no-warnings'],
        { timeout: 120000 }
      );
    }

    // Final scan for all platforms
    const finalFiles = await scanForMedia(outputDir);
    logger.info(`Downloaded ${finalFiles.length} unique media files`);

    if (finalFiles.length === 0) {
      try { await fs.rm(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error('No media files found after download');
    }

    return finalFiles;
  } catch (error: any) {
    logger.error('Album download failed', error);
    try { await fs.rm(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Failed to download album: ${error.message}`);
  }
}

/**
 * Check if a URL contains media (images/videos) or is an album/carousel.
 * All external commands use spawn() with argument arrays — no shell injection.
 */
export async function isAlbum(url: string): Promise<boolean> {
  try {
    // Instagram detection
    if (url.includes('instagram.com')) {
      if (url.includes('/reel/') || url.includes('/reels/') || url.includes('/tv/')) {
        logger.info('Detected Instagram Video (Reel/TV), will use yt-dlp');
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
      if (
        url.includes('/watch') ||
        url.includes('/reel/') ||
        url.includes('/reels/') ||
        url.includes('fb.watch')
      ) {
        logger.info('Detected Facebook video (watch/reel), will use yt-dlp');
        return false;
      }

      if (url.includes('/share/')) {
        try {
          const args = [url, '--print', '%(ext)s', '--no-warnings'];
          if (config.cookiesPath) args.push('--cookies', config.cookiesPath);

          const { stdout } = await spawnAsync(config.ytDlpPath, args, { timeout: 10000 });
          const ext = stdout.trim().toLowerCase();

          if (['mp4', 'webm', 'mkv', 'm4v'].includes(ext)) {
            logger.info('Detected Facebook video (share), will use yt-dlp');
            return false;
          }

          logger.info('Detected Facebook photo/album (share), will attempt image download');
          return true;
        } catch {
          logger.info('Facebook share probe failed, attempting proxy resolution...');

          try {
            const resolutionUA =
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
            const { stdout: resUrl } = await spawnAsync(
              'curl',
              ['-sL', '-o', '/dev/null', '-w', '%{url_effective}', '-A', resolutionUA, url],
              { timeout: 10000 }
            );
            const bestUrl = resUrl && !resUrl.includes('/login') ? resUrl.trim() : url;

            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(bestUrl)}`;
            const { stdout: content } = await spawnAsync('curl', ['-sL', proxyUrl], { timeout: 30000 });

            if (content.includes('og:video') || content.includes('"video_id":"')) {
              logger.info('Detected Facebook video (share) via proxy content');
              return false;
            }

            if (content.includes('Connectez-vous') || content.includes('Log In') || content.length < 10000) {
              const fbidMatch =
                bestUrl.match(/(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/) ||
                content.match(/"fbid":"(\d+)"/);
              const checkFbid = fbidMatch ? fbidMatch[1] : null;

              const pluginUrlForCheck = checkFbid
                ? `https://www.facebook.com/facebook/posts/${checkFbid}`
                : bestUrl;
              const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(pluginUrlForCheck)}`;
              const proxyEmbedUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
              const { stdout: embedContent } = await spawnAsync('curl', ['-sL', proxyEmbedUrl], { timeout: 20000 });

              if (
                embedContent.includes('swfobject') ||
                embedContent.includes('video_id') ||
                embedContent.includes('"video_id"')
              ) {
                logger.info('Detected Facebook video (share) via Embed Plugin');
                return false;
              }
            }
          } catch {
            logger.warn('Initial proxy (Codetabs) in isAlbum failed, trying AllOrigins...');
            try {
              const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
              const { stdout: proxyJson } = await spawnAsync('curl', ['-s', proxyUrl], { timeout: 30000 });
              if (proxyJson && proxyJson.startsWith('{')) {
                const proxyData = JSON.parse(proxyJson);
                const content = proxyData.contents || '';
                if (content.includes('og:video') || content.includes('"video_id":"')) {
                  logger.info('Detected Facebook video (share) via AllOrigins proxy');
                  return false;
                }
              }
            } catch {
              logger.error('All proxy resolution fallbacks in isAlbum failed');
            }
          }

          if (url.includes('/share/v/') || url.includes('/share/r/')) {
            logger.info('Uncertain /share/v or /share/r link, assuming album/hybrid first');
            return true;
          }
          return true;
        }
      }

      if (
        url.includes('photo.php') ||
        url.includes('permalink.php') ||
        url.includes('/photos/') ||
        url.includes('/posts/') ||
        url.includes('/story.php')
      ) {
        logger.info('Detected Facebook photo/album/post, will attempt image download');
        return true;
      }
    }

    // TikTok detection
    if (url.includes('tiktok.com')) {
      if (url.includes('/photo/')) {
        logger.info('Detected TikTok photo carousel (URL contains /photo/)');
        return true;
      }

      try {
        const { stdout, stderr } = await spawnAsync(
          config.galleryDlPath,
          [url, '--get-urls'],
          { timeout: 10000 }
        );
        const output = (stdout + (stderr || '')).toLowerCase();
        const urls = stdout.trim().split('\n').filter(line => line.startsWith('http'));

        if (output.includes('/photo/')) {
          logger.info('Detected TikTok photo carousel (gallery-dl output contains /photo/)');
          return true;
        }

        if (urls.length > 1) {
          logger.info('Detected TikTok photo carousel (multiple images)');
          return true;
        }

        logger.info('Detected TikTok video (single item), will use yt-dlp');
        return false;
      } catch {
        return false;
      }
    }

    // General detection via yt-dlp
    const { stdout: playlistCheck } = await spawnAsync(
      config.ytDlpPath,
      [url, '--flat-playlist', '--print', '%(playlist_count)s', '--no-warnings'],
      { timeout: 10000 }
    ).catch(() => ({ stdout: '' }));

    if (parseInt(playlistCheck.trim()) > 1) return true;

    try {
      const result = await spawnAsync(
        config.ytDlpPath,
        [url, '--print', '%(ext)s'],
        { timeout: 10000 }
      );
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
