import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { spawnAsync } from '../utils/spawnAsync.js';
import fs from 'fs/promises';

/**
 * Try to extract a direct video URL using yt-dlp --get-url
 */
async function getVideoUrlFromAPI(fbUrl: string): Promise<string | null> {
  try {
    const args = [fbUrl, '--get-url', '--no-warnings'];
    if (config.cookiesPath) {
      args.push('--cookies', config.cookiesPath);
    }

    const { stdout } = await spawnAsync(config.ytDlpPath, args, { timeout: 15000 });
    if (stdout.trim()) {
      return stdout.trim().split('\n')[0];
    }
  } catch {
    logger.warn('Failed to extract video URL via yt-dlp --get-url');
  }
  return null;
}

/**
 * Resolve Facebook share links to canonical URLs (handles share/r/ etc.)
 * Uses curl with args array to avoid shell injection.
 */
export async function resolveFacebookShareLink(url: string): Promise<string> {
  if (!url.includes('share/') && !url.includes('share.php') && !url.includes('fb.watch')) {
    return url;
  }

  const resolutionUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  // Tier 1: Quick local resolution
  try {
    const { stdout } = await spawnAsync(
      'curl',
      ['-sL', '-I', '-o', '/dev/null', '-w', '%{url_effective}', '-A', resolutionUA, url],
      { timeout: 15000 }
    );
    const resolved = stdout.trim();
    if (resolved && resolved !== url && !resolved.includes('/login') && !resolved.includes('checkpoint')) {
      logger.info(`Resolved share link: ${url} -> ${resolved}`);
      return resolved;
    }
  } catch {
    logger.warn('Direct resolution failed, trying proxy...');
  }

  // Tier 2: Proxy Fallback (Codetabs)
  let content = '';
  try {
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
    const { stdout } = await spawnAsync('curl', ['-sL', proxyUrl], { timeout: 30000 });
    content = stdout;
  } catch {
    logger.warn('Codetabs proxy failed, trying AllOrigins...');
    try {
      // Tier 3: AllOrigins proxy
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const { stdout: proxyJson } = await spawnAsync('curl', ['-s', proxyUrl], { timeout: 30000 });
      if (proxyJson && proxyJson.startsWith('{')) {
        const proxyData = JSON.parse(proxyJson);
        content = proxyData.contents || '';
      }
    } catch {
      logger.error('All proxy resolutions failed');
    }
  }

  if (content) {
    // 1. Check for canonical link
    const canonicalMatch = content.match(/link rel="canonical" href="([^"]+)"/);
    if (canonicalMatch && !canonicalMatch[1].includes('/login')) {
      logger.info(`Resolved share link via proxy to canonical: ${canonicalMatch[1]}`);
      return canonicalMatch[1];
    }

    // 2. Extract Reel/Video ID patterns
    const idMatch =
      content.match(/reel\/(\d+)/) ||
      content.match(/videos\/(\d+)/) ||
      content.match(/videos\/[^/]+\/(\d+)/) ||
      content.match(/"video_id":"(\d+)"/);

    if (idMatch) {
      const id = idMatch[1];
      const resolved = content.includes('reel')
        ? `https://www.facebook.com/reel/${id}`
        : `https://www.facebook.com/videos/${id}`;
      logger.info(`Resolved share link via proxy ID extraction to: ${resolved}`);
      return resolved;
    }

    // 3. Encoded URLs in redirects
    const encodedMatch = content.match(/reel%2F(\d+)/) || content.match(/videos%2F(\d+)/);
    if (encodedMatch) {
      const id = encodedMatch[1];
      const resolved = content.includes('reel')
        ? `https://www.facebook.com/reel/${id}`
        : `https://www.facebook.com/videos/${id}`;
      logger.info(`Resolved share link via proxy (encoded) to: ${resolved}`);
      return resolved;
    }
  }

  return url;
}

/**
 * Extract video URL from Facebook Embed Plugin via Proxy
 */
async function getEmbedVideoUrl(url: string): Promise<string | null> {
  const userAgent =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

  const tryExtract = async (proxyUrl: string): Promise<string | null> => {
    const { stdout } = await spawnAsync('curl', ['-sL', '-A', userAgent, proxyUrl], { timeout: 30000 });

    const hdMatch = stdout.match(/"hd_src":"([^"]+)"/);
    if (hdMatch) return hdMatch[1].replace(/\\\//g, '/');

    const sdMatch = stdout.match(/"sd_src":"([^"]+)"/);
    if (sdMatch) return sdMatch[1].replace(/\\\//g, '/');

    const mp4Match = stdout.match(/https:[^"']+\.mp4/g);
    if (mp4Match && mp4Match.length > 0) {
      logger.info('Found generic mp4 URL in Embed Plugin');
      return mp4Match[0].replace(/\\\//g, '/');
    }
    return null;
  };

  try {
    const resolvedUrl = await resolveFacebookShareLink(url);
    const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(resolvedUrl)}`;
    logger.info(`Strategy 4: Fetching Embed Plugin via Codetabs proxy`);

    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
    const result = await tryExtract(proxyUrl);
    if (result) return result;
  } catch (error: any) {
    logger.warn(`Strategy 4 (Embed Plugin - Codetabs) failed: ${error.message}. Trying AllOrigins...`);
  }

  try {
    const resolvedUrl = await resolveFacebookShareLink(url);
    const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(resolvedUrl)}`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`;
    const result = await tryExtract(proxyUrl);
    if (result) return result;
  } catch (e: any) {
    logger.warn(`Strategy 4 (Embed Plugin - AllOrigins) failed: ${e.message}`);
  }

  return null;
}

/**
 * Download Facebook video using yt-dlp with aggressive retry and fallback strategies.
 * All external commands use spawn() with argument arrays — no shell interpolation.
 */
export async function downloadFacebookVideo(url: string, outputPath: string): Promise<string> {
  logger.info(`Attempting Facebook download: ${url}`);

  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  const buildYtDlpArgs = (targetUrl: string): string[] => {
    const args = [
      targetUrl,
      '-o', outputPath,
      '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
      '--merge-output-format', 'mp4',
      '--user-agent', userAgent,
      '--no-warnings',
    ];
    if (config.cookiesPath) {
      args.push('--cookies', config.cookiesPath);
    }
    // NOTE: --cookies-from-browser chrome is intentionally omitted here; it
    // will silently fail in a containerised environment (no Chrome profile).
    return args;
  };

  // Strategy 1: Direct approach (original URL + configured cookies)
  try {
    logger.info('Strategy 1: yt-dlp with original URL and cookies');
    await spawnAsync(config.ytDlpPath, buildYtDlpArgs(url), { timeout: 90000 });

    if (await checkFileExists(outputPath)) {
      logger.info('Facebook download successful with Strategy 1');
      return outputPath;
    }
  } catch (error: any) {
    logger.warn(`Strategy 1 failed: ${String(error.message).split('\n')[0]}`);
  }

  // Strategy 2: Resolved URL (essential for share/r/ links)
  try {
    const resolvedUrl = await resolveFacebookShareLink(url);
    if (resolvedUrl !== url) {
      logger.info(`Strategy 2: yt-dlp with resolved URL: ${resolvedUrl}`);
      await spawnAsync(config.ytDlpPath, buildYtDlpArgs(resolvedUrl), { timeout: 90000 });

      if (await checkFileExists(outputPath)) {
        logger.info('Facebook download successful with Strategy 2');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 2 failed: ${String(error.message).split('\n')[0]}`);
  }

  // Strategy 3: Direct video URL → curl download
  try {
    logger.info('Strategy 3: direct video URL extraction via yt-dlp --get-url');
    const videoUrl = await getVideoUrlFromAPI(url);
    if (videoUrl) {
      const finalPath = outputPath.replace('%(ext)s', 'mp4');
      logger.info('Downloading via curl...');
      await spawnAsync('curl', ['-sL', '-A', userAgent, '-o', finalPath, videoUrl], { timeout: 120000 });
      if (await checkFileExists(finalPath)) {
        logger.info('Facebook download successful with Strategy 3');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 3 failed: ${String(error.message).split('\n')[0]}`);
  }

  // Strategy 4: Embed Plugin scraping
  try {
    logger.info('Strategy 4: Embed Plugin scraping fallback');
    const videoUrl = await getEmbedVideoUrl(url);
    if (videoUrl) {
      const finalPath = outputPath.replace('%(ext)s', 'mp4');
      try {
        await spawnAsync(
          config.ytDlpPath,
          [videoUrl, '-o', finalPath, '--no-warnings', '--user-agent', userAgent],
          { timeout: 120000 }
        );
      } catch {
        await spawnAsync('curl', ['-sL', '-A', userAgent, '-o', finalPath, videoUrl], { timeout: 120000 });
      }
      if (await checkFileExists(finalPath)) {
        logger.info('Facebook download successful with Strategy 4');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 4 failed: ${String(error.message).split('\n')[0]}`);
  }

  throw new Error(
    "❌ Facebook videos cannot be downloaded due to Facebook's strict anti-bot protection. " +
    'Try downloading from TikTok, Instagram, YouTube, or Twitter instead!'
  );
}

async function checkFileExists(outputPath: string): Promise<boolean> {
  const possibleFiles = [
    outputPath.replace('%(ext)s', 'mp4'),
    outputPath.replace('%(ext)s', 'mkv'),
    outputPath.replace('%(ext)s', 'webm'),
  ];

  for (const file of possibleFiles) {
    try {
      await fs.access(file);
      return true;
    } catch { /* continue */ }
  }
  return false;
}
