import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Safety wrapper for execAsync to prevent OOM and hanging processes
async function safeExec(command: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024, // 1MB limit for stdout/stderr to prevent OOM
  });
}

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
    // Facebook: Direct scraping from mbasic.facebook.com (works better than gallery-dl for photos)
    else if (url.includes('facebook.com') || url.includes('fb.com')) {
      logger.info('Using mbasic.facebook.com scraping for Facebook photos');

      let targetUrl = url;
      let fbid = '';
      let resolvedUrl = '';
      // Step 1: Follow redirect for share links to get the real post URL
      if (url.includes('/share/')) {
        try {
          // Use a modern browser user agent for resolution to avoid connection resets
          const resolutionUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

          logger.info(`Attempting Tier 1 resolution (local curl): ${url}`);
          const { stdout } = await safeExec(
            `curl -sL -o /dev/null -w "%{url_effective}" -A "${resolutionUA}" "${url}"`,
            15000
          );

          if (stdout.trim() && !stdout.includes('/login') && stdout.trim() !== url) {
            targetUrl = stdout.trim();
            resolvedUrl = targetUrl; // Store the high-quality redirected URL
            logger.info(`Resolved share link to: ${targetUrl}`);

            // Extract fbid/story_fbid from resolved URL
            const storyFbidMatch = targetUrl.match(/story_fbid=(\d+)/);
            const fbidParamMatch = targetUrl.match(/fbid=(\d+)/);

            if (storyFbidMatch) {
              fbid = storyFbidMatch[1];
            } else if (fbidParamMatch) {
              fbid = fbidParamMatch[1];
            }
          } else {
            logger.warn(`Tier 1 resolution returned same URL or login wall: ${stdout.trim()}`);
            throw new Error('Tier 1 resolution failed to resolve');
          }
        } catch (e: any) {
          logger.warn(`Tier 1 resolution failed: ${e.message}. Attempting Tier 2 (Proxy Fallback via Codetabs)...`);

          let content = '';

          try {
            // Tier 2: Proxy Fallback via codetabs.com (Direct HTML)
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
            const { stdout } = await safeExec(`curl -sL "${proxyUrl}"`, 20000);
            content = stdout;
          } catch (proxyError: any) {
            logger.warn(`Tier 2 (Codetabs) failed: ${proxyError.message}. Attempting Tier 3 (AllOrigins)...`);

            try {
              // Tier 3: Proxy Fallback via allorigins.win
              const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
              const { stdout: proxyJson } = await safeExec(`curl -s "${proxyUrl}"`, 20000);
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

            // Priority 1: Check if the resolved URL itself contains the ID (Most reliable)
            // Support pfbid, share/p, videos, etc.
            const urlIdMatch = resolvedUrl.match(/(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^\/]+\/|posts\/|pfbid|videos\/|share\/p\/|share\/v\/)([a-zA-Z0-9]+)/);
            if (urlIdMatch) {
              fbid = urlIdMatch[1];
              logger.info(`Extracted ID from resolved URL: ${fbid}`);
            } else {
              // Only search HTML if URL didn't yield an ID
              // Search for tell-tale Facebook ID patterns in the HTML
              // Priority 2: story_fbid
              const storyFbidMatch = content.match(/\"story_fbid\":\"(\d+)\"/);
              // Priority 3: fbid in URLs
              const fbidMatch = content.match(/fbid=(\d+)/);
              // Also try to find canonical link (highest quality for Embed Plugin)
              const canonicalMatch = content.match(/link rel=\"canonical\" href=\"([^"]+)\"/);
              if (canonicalMatch && !canonicalMatch[1].includes('/login')) {
                const canonicalUrl = canonicalMatch[1];
                logger.info(`Found canonical URL via proxy: ${canonicalUrl}`);

                // Check if it's a video
                if (canonicalUrl.includes('/videos/') || canonicalUrl.includes('/reel/') || canonicalUrl.includes('/watch/')) {
                  logger.info('Canonical URL indicates VIDEO. Aborting image download.');
                  return [];
                }

                // Try to extract ID from canonical
                const canonicalIdMatch = canonicalUrl.match(/(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^\/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/);
                if (canonicalIdMatch) {
                  fbid = canonicalIdMatch[1];
                  logger.info(`Extracted ID from canonical URL: ${fbid}`);
                }
              }

              // Priority 4: any long digit strings (usually IDs) - LAST RESORT
              if (!fbid) {
                // ... existing generic ID logic ...
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

            // If the resolved URL or content indicates a VIDEO, abort album processing
            if (resolvedUrl.includes('/videos/') || resolvedUrl.includes('/reel/') || resolvedUrl.includes('/watch/') || resolvedUrl.includes('share/v/')) {
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

      // Final check for resolvedUrl: must not be a login page
      if (resolvedUrl && resolvedUrl.includes('/login')) {
        logger.warn(`Discarding login-bound resolved URL: ${resolvedUrl}`);
        resolvedUrl = '';
      }
      if (!resolvedUrl) resolvedUrl = targetUrl;

      // Extract fbid from various URL formats if not already found
      if (!fbid) {
        // Updated regex to support alphanumeric IDs (pfbid) and posts path
        const fbidMatch = targetUrl.match(/(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^\/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/);
        if (fbidMatch) {
          fbid = fbidMatch[1];
        }
      }

      // Step 2: Try mbasic.facebook.com scraping (primary method for photos)
      if (fbid) {
        logger.info(`Extracted Facebook photo ID: ${fbid}`);

        try {
          // Construct URL: use /posts/ for pfbid or post IDs, /photo.php for numeric photo IDs
          // Use /posts/ if it looks like a pfbid or if we extracted it from a /posts/ URL
          const mbasicUrl = (fbid.startsWith('pfbid') || targetUrl.includes('/posts/'))
            ? `https://mbasic.facebook.com/posts/${fbid}`
            : `https://mbasic.facebook.com/photo.php?fbid=${fbid}`;

          logger.info(`Attempting mbasic scraping: ${mbasicUrl}`);
          let stdout = '';
          const modernUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
          const botUA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

          try {
            // Tier 1: Local scraping (NO COOKIES to avoid session block)
            const { stdout: localStdout } = await execAsync(
              `curl -sL -A "${modernUA}" "${mbasicUrl}"`,
              { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            );
            stdout = localStdout;
          } catch (localError: any) {
            logger.warn(`mbasic local scraping failed: ${localError.message}. Attempting Tier 2 proxy (Modern UA)...`);
            try {
              // Tier 2: Proxy scraping (Modern UA)
              const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(mbasicUrl)}`;
              const { stdout: proxyStdout } = await execAsync(`curl -sL -A "${modernUA}" "${proxyUrl}"`, { timeout: 30000 });
              stdout = proxyStdout;

              if (stdout.includes('Connectez-vous') || stdout.includes('Log In') || stdout.length < 10000) {
                logger.warn('Tier 2 returned login wall or small content. Attempting Tier 3 proxy (Bot UA)...');
                const { stdout: botStdout } = await execAsync(`curl -sL -A "${botUA}" "${proxyUrl}"`, { timeout: 30000 });
                stdout = botStdout;
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

          // Initial extraction from mbasic content
          const extractImages = (content: string) => {
            const matches = content.match(/(?:scontent|fbcdn\.net)[^\s"<>']+/g) || [];
            let ogMatch = content.match(/property="og:image" content="([^"]+)"/) || content.match(/"og:image" content="([^"]+)"/);

            let urls = matches
              .map(u => {
                let cleanUrl = u.replace(/&amp;/g, '&').replace(/\\\//g, '/');
                if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
                return cleanUrl;
              })
              .filter(u => {
                const hasDomain = u.includes('scontent') || u.includes('fbcdn.net');
                const lowerUrl = u.toLowerCase();
                const hasExt = lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg') || lowerUrl.includes('.png') || lowerUrl.includes('.kf') || lowerUrl.includes('_nc_');
                const isStatic = u.includes('rsrc.php') || u.includes('emoji.php') || u.includes('/catalog/') || u.includes('ad_') || lowerUrl.includes('t15.') || lowerUrl.includes('/t15/') || lowerUrl.includes('t16.');
                return hasDomain && hasExt && !isStatic;
              });

            if (urls.length === 0 && ogMatch) {
              urls = [ogMatch[1].replace(/&amp;/g, '&').replace(/\\\//g, '/')];
            }
            return urls;
          };

          let imageUrls = extractImages(stdout);
          logger.info(`Initial mbasic sweep found ${imageUrls.length} image URLs`);

          // Tier 4: Embed Plugin Fallback (Trigger if no images OR login wall)
          const isLoginWall = stdout.includes('Connectez-vous') || stdout.includes('Log In') || (stdout.length > 0 && stdout.length < 5000);

          if (imageUrls.length === 0 || isLoginWall) {
            logger.info(`mbasic failed (URLs: ${imageUrls.length}, LoginWall: ${isLoginWall}). Attempting Tier 4 (Embed Plugin)...`);
            try {
              const pluginHref = fbid ? `https://www.facebook.com/facebook/posts/${fbid}` : (resolvedUrl || targetUrl);
              const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(pluginHref)}`;
              const proxyEmbedUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
              const { stdout: embedStdout } = await execAsync(`curl -sL -A "${modernUA}" "${proxyEmbedUrl}"`, { timeout: 30000 });

              if (embedStdout && embedStdout.length > 1000) {
                logger.info(`Embed Plugin scraping returned ${embedStdout.length} bytes`);
                const embedUrls = extractImages(embedStdout);
                if (embedUrls.length > 0) {
                  logger.info(`Embed Plugin rescued the download with ${embedUrls.length} images!`);
                  imageUrls = embedUrls;
                  stdout = embedStdout; // Update content for video check
                }
              }
            } catch (embedError: any) {
              logger.warn(`Embed Plugin scraping failed: ${embedError.message}`);
            }
          }

          // Check if final content indicates video
          if (stdout.includes('video_id') || stdout.includes('"video_id"') || stdout.includes('swfobject')) {
            logger.info('Content indicates VIDEO. Aborting image download.');
            return [];
          }

          logger.info(`mbasic filtered to ${imageUrls.length} valid image URLs`);

          // Group URLs by unique content ID to support albums
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

              if (!imageGroups.has(contentId)) {
                imageGroups.set(contentId, []);
              }
              imageGroups.get(contentId)?.push(u);
            });
          }

          logger.info(`Found ${imageGroups.size} unique image content groups`);

          // Download the best image from each group
          for (const [contentId, groupUrls] of imageGroups) {
            // Filter out likely profile pictures/icons if we have varying sizes? 
            // For now, download everything that looks like a photo

            // Sort by length (descending) to get best resolution
            // 1. Sort by resolution (parsing dimensions from URL)
            const getDimensions = (u: string) => {
              const match = u.match(/[sp](\d+)x(\d+)/);
              if (match) {
                return { w: parseInt(match[1]), h: parseInt(match[2]), pixels: parseInt(match[1]) * parseInt(match[2]) };
              }
              // If it's a valid FB URL but HAS NO size marker, it's often the original/highest res
              // Assign it a huge virtual size to prioritize it over thumbnails
              if ((u.includes('scontent') || u.includes('fbcdn')) && !u.includes('s100x100') && !u.includes('p100x100')) {
                return { w: 9999, h: 9999, pixels: 99999999 };
              }
              return { w: 0, h: 0, pixels: 0 };
            };

            const bestUrl = groupUrls.sort((a, b) => {
              const dimA = getDimensions(a);
              const dimB = getDimensions(b);

              // Primary sort: Total pixels
              if (dimA.pixels !== dimB.pixels) return dimB.pixels - dimA.pixels;

              // Secondary sort: URL length (longer often means signed/better)
              return b.length - a.length;
            })[0];

            const dims = getDimensions(bestUrl);
            logger.info(`Best variant for ID ${contentId}: ${dims.w}x${dims.h} (${bestUrl.substring(0, 50)}...)`);

            // 2. Filter out likely profile pictures or tiny thumbnails
            // Strict check: both dimensions must be significant (e.g. > 200px)
            // Profile pics are often 50x50, 100x100, 160x160.
            // Content images are usually > 300px.
            const minDimension = 200;
            if (dims.w > 0 && (dims.w < minDimension || dims.h < minDimension)) {
              logger.info(`Skipping small image (likely profile/thumbnail) ID ${contentId}: ${dims.w}x${dims.h}`);
              continue;
            }

            // Also filter explicitly known small markers just in case regex failed
            if (bestUrl.includes('cp0_dst_jpg_p50x50') || bestUrl.includes('p50x50') || bestUrl.includes('s50x50')) {
              continue;
            }

            // Use the content ID for filename, or fbid_index if generic
            const uniqueFilename = contentId === 'default' || contentId === 'og_image' ? `${fbid}.jpg` : `${contentId}.jpg`;
            const imagePath = path.join(outputDir, uniqueFilename);

            logger.info(`Downloading image (ID: ${contentId}): ${imagePath}`);
            const minSize = 25000; // Increased to 25KB to be very safe and filter icons/emojis

            try {
              await execAsync(`curl -sL -o "${imagePath}" "${bestUrl}"`, { timeout: 30000 });

              const stat = await fs.stat(imagePath);
              if (stat.size > minSize) {
                // File is good, scanForMedia will pick it up
              } else {
                logger.warn(`Downloaded file too small (${stat.size} bytes), likely thumbnail/error. Removing: ${imagePath}`);
                await fs.unlink(imagePath).catch(() => { });
              }
            } catch (dlError: any) {
              logger.warn(`Direct image download failed for ${contentId}: ${dlError.message}. Attempting weserv.nl...`);
              const proxyImageUrl = `https://images.weserv.nl/?url=${encodeURIComponent(bestUrl)}`;
              try {
                await execAsync(`curl -sL -o "${imagePath}" "${proxyImageUrl}"`, { timeout: 30000 });
                // scanForMedia will pick it up
              } catch (e) {
                logger.error(`Failed to download image ${contentId} via proxy too`);
              }
            }
          }
        } catch (e: any) {
          logger.warn(`mbasic scraping overall failed: ${e.message}`);
        }
      }

      // Check if mbasic worked
      let files = await scanForMedia(outputDir);

      // Check for low-resolution results (often caused by Embed Plugin limits on single photos)
      let isLowQuality = false;
      let lowQualityFile: DownloadedMedia | null = null;

      if (files.length === 1 && files[0].type === 'photo') {
        try {
          const stats = await fs.stat(files[0].path);
          // If file is < 40KB, it's likely a 500px preview (usually ~20-30KB).
          // High res 960px+ is usually > 60KB. 100KB+ is ideal.
          if (stats.size < 40 * 1024) {
            logger.warn(`Downloaded single image is low quality (${Math.round(stats.size / 1024)}KB). Attempting gallery-dl fallback (keeping original as backup)...`);
            isLowQuality = true;
            lowQualityFile = files[0];
          }
        } catch (e) { }
      }

      // Step 3: Fallback to gallery-dl if mbasic didn't work OR returned low quality
      if (files.length === 0 || isLowQuality) {
        if (isLowQuality) logger.info('Retrying with gallery-dl for higher resolution...');
        else logger.info('mbasic approach detected no media, using gallery-dl fallback...');

        const galleryDlPath = config.galleryDlPath;
        const cookiesArg = config.cookiesPath
          ? `--cookies "${config.cookiesPath}"`
          : '--cookies-from-browser chrome';

        try {
          await execAsync(
            `${galleryDlPath} "${targetUrl}" --dest "${outputDir}" ${cookiesArg} --no-mtime --write-metadata --range 1`,
            { timeout: 60000 }
          );
        } catch (e: any) {
          logger.warn(`gallery-dl fallback failed: ${e.message}`);
        }

        // Re-scan to see if we got anything better
        const newFiles = await scanForMedia(outputDir);

        // Smart merge logic:
        // 1. If gallery-dl worked and gave us a better file, great.
        // 2. If it failed, we fall back to our 'lowQualityFile' (if we had one).
        if (newFiles.length > 0) {
          // Check if we just have the same old file or a new one
          if (isLowQuality && lowQualityFile && newFiles.length === 1 && newFiles[0].path === lowQualityFile.path) {
            // It's the same file, gallery-dl likely failed or didn't overwrite
            logger.warn('Gallery-dl did not improve quality. Returning original/low-res version.');
          } else if (isLowQuality) {
            logger.info('Gallery-dl succeeded or added files!');
            // Clean up the old low res file if it has a different name and still exists?
            // Usually gallery-dl overwrites if same name, or we just return distinct files.
          }
          files = newFiles;
        } else if (isLowQuality && lowQualityFile) {
          // Gallery-dl returned NOTHING (e.g. failed completely), but we still have our backup
          logger.warn('Gallery-dl returned no files. Falling back to original low-res download.');
          files = [lowQualityFile];
        }
      }



      // ADVANCED FALLBACK: Timeline Scan (Now the primary recovery method)
      // If we only got 1 image but it's a known post format, reconstruction is likely needed.
      if (files.length === 1 && (targetUrl.includes('/posts/') || targetUrl.includes('fbid=') || targetUrl.includes('permalink.php') || targetUrl.includes('/photos/') || targetUrl.includes('/share/p/'))) {
        logger.info('Reconstructing gallery via Timeline Scan (High-Speed Mode)...');

        try {
          const galleryDlPath = config.galleryDlPath;
          const cookiesArg = config.cookiesPath
            ? `--cookies "${config.cookiesPath}"`
            : '--cookies-from-browser chrome';
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
            } catch { }
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
    // Quick regex checks first to avoid spawning processes
    if (url.includes('tiktok.com')) {
      if (url.includes('/photo/')) return true;
      if (url.includes('/video/')) return false;
    }

    // Instagram detection
    if (url.includes('instagram.com')) {
      if (url.includes('/reel/') || url.includes('/reels/') || url.includes('/tv/')) {
        return false;
      }
      return !!getInstagramShortcode(url);
    }

    // Facebook detection
    if (url.includes('facebook.com') || url.includes('fb.com')) {
      if (
        url.includes('/watch') ||
        url.includes('/reel/') ||
        url.includes('/reels/') ||
        url.includes('fb.watch')
      ) {
        return false;
      }

      // Explicit photo/post patterns
      if (
        url.includes('photo.php') ||
        url.includes('permalink.php') ||
        url.includes('/photos/') ||
        url.includes('/posts/') ||
        url.includes('/story.php')
      ) {
        return true;
      }

      // For share links, we might need a quick probe
      if (url.includes('/share/')) {
        try {
          const { stdout } = await safeExec(
            `"${config.ytDlpPath}" "${url}" --print "%(ext)s" --no-warnings --no-check-certificates 2>&1`,
            8000
          );
          const ext = stdout.trim().toLowerCase();
          return !['mp4', 'webm', 'mkv', 'm4v'].includes(ext);
        } catch {
          // If probe fails, assume it's a photo/album to be safe
          // (v/r share links are often hybrid)
          return url.includes('/share/v/') || url.includes('/share/r/');
        }
      }
      return true;
    }

    // General fallback for unknown patterns - only probe if we have to
    const { stdout: playlistCheck } = await safeExec(
      `"${config.ytDlpPath}" "${url}" --flat-playlist --print "%(playlist_count)s" --no-warnings 2>&1`,
      8000
    ).catch(() => ({ stdout: '1' }));

    return parseInt(playlistCheck.trim()) > 1;
  } catch {
    return false;
  }
}
