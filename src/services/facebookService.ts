import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

/**
 * Try to extract video URL using third-party API
 */
async function getVideoUrlFromAPI(fbUrl: string): Promise<string | null> {
  try {
    // Using a simple approach - try to get video info from Facebook's own API
    const { stdout } = await execAsync(
      `"${config.ytDlpPath}" "${fbUrl}" --get-url --no-warnings 2>/dev/null || echo ""`
    );

    if (stdout.trim()) {
      return stdout.trim().split('\n')[0];
    }
  } catch (error) {
    logger.warn('Failed to extract video URL');
  }

  return null;
}

/**
 * Resolve Facebook share links to canonical URLs (handling share/r/ etc)
 */
async function resolveFacebookShareLink(url: string): Promise<string> {
  if (!url.includes('share/') && !url.includes('share.php')) return url;

  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    // Try simple curl -I first
    const { stdout } = await execAsync(`curl -sL -I -o /dev/null -w "%{url_effective}" -A "${userAgent}" "${url}"`, { timeout: 15000 });
    const resolved = stdout.trim();
    if (resolved && resolved !== url && !resolved.includes('login')) {
      logger.info(`Resolved share link: ${url} -> ${resolved}`);
      return resolved;
    }
  } catch (e) {
    logger.warn('Direct resolution failed, trying proxy...');
  }

  // Tier 2: Proxy Fallback
  try {
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const { stdout } = await execAsync(`curl -sL -A "${userAgent}" "${proxyUrl}"`, { timeout: 30000 });

    // Extract Reel ID from login redirects or canonical links
    // Matches /reel/123456 or reel_id=123456
    const reelMatch = stdout.match(/reel\/(\d+)/) || stdout.match(/videos\/(\d+)/);
    if (reelMatch) {
      const id = reelMatch[1];
      const resolved = `https://www.facebook.com/reel/${id}`;
      logger.info(`Resolved share link via proxy to: ${resolved}`);
      return resolved;
    }

    // Also check for encoded URLs in login links
    // next=...reel%2F3034...
    const encodedMatch = stdout.match(/reel%2F(\d+)/);
    if (encodedMatch) {
      const id = encodedMatch[1];
      const resolved = `https://www.facebook.com/reel/${id}`;
      logger.info(`Resolved share link via proxy (encoded) to: ${resolved}`);
      return resolved;
    }

  } catch (e: any) {
    logger.warn(`Proxy resolution failed: ${e.message}`);
  }

  // If direct resolution failed, we might need to rely on the Embed Plugin handling the share link directly
  // or try a proxy resolution if critical. For now, return original if failed.
  return url;
}

/**
 * Extract video URL from Facebook Embed Plugin via Proxy
 */
async function getEmbedVideoUrl(url: string): Promise<string | null> {
  try {
    const resolvedUrl = await resolveFacebookShareLink(url);
    const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(resolvedUrl)}`;
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;

    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    logger.info(`Strategy 4: Fetching Embed Plugin via proxy: ${embedUrl}`);

    const { stdout } = await execAsync(`curl -sL -A "${userAgent}" "${proxyUrl}"`, { timeout: 30000 });

    // Look for hd_src or sd_src
    // URLs are often escaped like https:\/\/video...
    // Matches "hd_src":"https:..." or "sd_src":"https:..."
    // Simple regex to find any mp4 link
    const mp4Match = stdout.match(/https:[^"']+\.mp4/g);

    if (mp4Match && mp4Match.length > 0) {
      // Unescape the URL (remove backslashes)
      let videoUrl = mp4Match[0].replace(/\\\//g, '/');

      // Prefer HD if multiple found and one looks bigger/better?
      // Usually the first one in the list or specifically named hd_src
      // Let's try to find specific keys first

      const hdMatch = stdout.match(/"hd_src":"([^"]+)"/);
      if (hdMatch) return hdMatch[1].replace(/\\\//g, '/');

      const sdMatch = stdout.match(/"sd_src":"([^"]+)"/);
      if (sdMatch) return sdMatch[1].replace(/\\\//g, '/');

      // Fallback to first mp4 found
      logger.info('Found generic mp4 URL in Embed Plugin');
      return videoUrl;
    }
  } catch (error: any) {
    logger.warn(`Strategy 4 (Embed Plugin - Codetabs) failed: ${error.message}. Trying AllOrigins...`);

    try {
      // Fallback to AllOrigins
      const resolvedUrl = await resolveFacebookShareLink(url);
      const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(resolvedUrl)}`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`;
      const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

      const { stdout } = await execAsync(`curl -sL -A "${userAgent}" "${proxyUrl}"`, { timeout: 30000 });

      const mp4Match = stdout.match(/https:[^"']+\.mp4/g);
      if (mp4Match && mp4Match.length > 0) {
        let videoUrl = mp4Match[0].replace(/\\\//g, '/');
        const hdMatch = stdout.match(/"hd_src":"([^"]+)"/);
        if (hdMatch) return hdMatch[1].replace(/\\\//g, '/');
        const sdMatch = stdout.match(/"sd_src":"([^"]+)"/);
        if (sdMatch) return sdMatch[1].replace(/\\\//g, '/');
        logger.info('Found generic mp4 URL in Embed Plugin (allorigins)');
        return videoUrl;
      }
    } catch (e: any) {
      logger.warn(`Strategy 4 (Embed Plugin - AllOrigins) failed: ${e.message}`);
    }
  }
  return null;
}

/**
 * Download Facebook video using yt-dlp with aggressive retry and fallback strategies
 */
export async function downloadFacebookVideo(url: string, outputPath: string): Promise<string> {
  logger.info(`Attempting Facebook download: ${url}`);

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  const formatFlags = '-f "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4';

  // Strategy 1: Direct approach (Original URL + Configured Cookies)
  // This is the "Working" approach from prod logs
  try {
    const cookiesArg = config.cookiesPath
      ? `--cookies "${config.cookiesPath}"`
      : '--cookies-from-browser chrome';

    logger.info(`Strategy 1: Trying with original URL and cookies (${cookiesArg === `--cookies "${config.cookiesPath}"` ? 'cookies.txt' : 'browser'})`);

    await execAsync(
      `"${config.ytDlpPath}" "${url}" -o "${outputPath}" ${formatFlags} ${cookiesArg} --user-agent "${userAgent}" --no-check-certificates --no-warnings 2>&1`,
      { timeout: 90000 }
    );

    if (await checkFileExists(outputPath)) {
      logger.info('Facebook download successful with Strategy 1');
      return outputPath;
    }
  } catch (error: any) {
    logger.warn(`Strategy 1 failed: ${error.message.split('\n')[0]}`);
  }

  // Strategy 2: Resolved URL (Essential for share/r/ links if Strategy 1 fails)
  try {
    const resolvedUrl = await resolveFacebookShareLink(url);
    if (resolvedUrl !== url) {
      logger.info(`Strategy 2: Trying with resolved URL: ${resolvedUrl}`);
      const cookiesArg = config.cookiesPath ? `--cookies "${config.cookiesPath}"` : '--cookies-from-browser chrome';

      await execAsync(
        `"${config.ytDlpPath}" "${resolvedUrl}" -o "${outputPath}" ${formatFlags} ${cookiesArg} --user-agent "${userAgent}" --no-check-certificates --no-warnings 2>&1`,
        { timeout: 90000 }
      );

      if (await checkFileExists(outputPath)) {
        logger.info('Facebook download successful with Strategy 2');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 2 failed: ${error.message.split('\n')[0]}`);
  }

  // Strategy 3: API Fallback
  try {
    logger.info('Strategy 3: Trying direct video URL extraction');
    const videoUrl = await getVideoUrlFromAPI(url);
    if (videoUrl) {
      const finalPath = outputPath.replace('%(ext)s', 'mp4');
      logger.info('Downloading via curl fallback...');
      await execAsync(`curl -sL -A "${userAgent}" -o "${finalPath}" "${videoUrl}"`, { timeout: 120000 });
      if (await checkFileExists(finalPath)) {
        logger.info('Facebook download successful with Strategy 3');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 3 failed: ${error.message.split('\n')[0]}`);
  }

  // Strategy 4: Embed Plugin Scraping (The "Brute Force" Fallback)
  try {
    logger.info('Strategy 4: Trying Embed Plugin scraping fallback');
    const videoUrl = await getEmbedVideoUrl(url);
    if (videoUrl) {
      const finalPath = outputPath.replace('%(ext)s', 'mp4');
      try {
        await execAsync(`"${config.ytDlpPath}" "${videoUrl}" -o "${finalPath}" --no-check-certificates --no-warnings --user-agent "${userAgent}"`, { timeout: 120000 });
      } catch {
        await execAsync(`curl -sL -A "${userAgent}" -o "${finalPath}" '${videoUrl}'`, { timeout: 120000 });
      }
      if (await checkFileExists(finalPath)) {
        logger.info('Facebook download successful with Strategy 4');
        return outputPath;
      }
    }
  } catch (error: any) {
    logger.warn(`Strategy 4 failed: ${error.message.split('\n')[0]}`);
  }

  throw new Error('❌ Facebook videos cannot be downloaded due to Facebook\'s strict anti-bot protection. Try downloading from TikTok, Instagram, YouTube, or Twitter instead!');
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
    } catch { }
  }
  return false;
}

