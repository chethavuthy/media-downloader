import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import https from 'https';
import http from 'http';
import { createWriteStream } from 'fs';

const execAsync = promisify(exec);

/**
 * Download file from URL
 */
async function downloadFile(url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = createWriteStream(outputPath);

    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        if (response.headers.location) {
          downloadFile(response.headers.location, outputPath).then(resolve).catch(reject);
        } else {
          reject(new Error('Redirect without location'));
        }
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(outputPath).catch(() => { });
      reject(err);
    });

    file.on('error', (err) => {
      fs.unlink(outputPath).catch(() => { });
      reject(err);
    });
  });
}

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
 * Download Facebook video using yt-dlp with aggressive retry and fallback strategies
 */
export async function downloadFacebookVideo(url: string, outputPath: string): Promise<string> {
  logger.info(`Attempting Facebook download: ${url}`);

  // Strategy 1: Try with cookies
  try {
    const cookiesArg = config.cookiesPath
      ? `--cookies "${config.cookiesPath}"`
      : '--cookies-from-browser chrome';

    logger.info(`Strategy 1: Trying with cookies (${cookiesArg})`);
    await execAsync(
      `"${config.ytDlpPath}" "${url}" -o "${outputPath}" -f "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 ${cookiesArg} --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --no-warnings 2>&1`,
      { timeout: 60000 }
    );

    // Check if file was created
    const possibleFiles = [
      outputPath.replace('%(ext)s', 'mp4'),
      outputPath.replace('%(ext)s', 'mkv'),
      outputPath.replace('%(ext)s', 'webm'),
    ];

    for (const file of possibleFiles) {
      try {
        await fs.access(file);
        logger.info('Facebook download successful with cookies');
        return outputPath;
      } catch { }
    }
  } catch (error: any) {
    logger.warn(`Strategy 1 failed: ${error.message}`);
  }

  // Strategy 2: Try direct download without impersonation
  try {
    logger.info('Strategy 2: Trying direct download');
    await execAsync(
      `"${config.ytDlpPath}" "${url}" -o "${outputPath}" -f "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" --no-check-certificates --no-warnings 2>&1`,
      { timeout: 60000 }
    );

    const possibleFiles = [
      outputPath.replace('%(ext)s', 'mp4'),
      outputPath.replace('%(ext)s', 'mkv'),
      outputPath.replace('%(ext)s', 'webm'),
    ];

    for (const file of possibleFiles) {
      try {
        await fs.access(file);
        logger.info('Facebook download successful with direct method');
        return outputPath;
      } catch { }
    }
  } catch (error: any) {
    logger.warn(`Strategy 2 failed: ${error.message}`);
  }

  // Strategy 3: Try to get direct video URL and download
  try {
    logger.info('Strategy 3: Trying to extract direct video URL');
    const videoUrl = await getVideoUrlFromAPI(url);

    if (videoUrl) {
      const finalPath = outputPath.replace('%(ext)s', 'mp4');
      await downloadFile(videoUrl, finalPath);
      logger.info('Facebook download successful with direct URL');
      return outputPath;
    }
  } catch (error: any) {
    logger.warn(`Strategy 3 failed: ${error.message}`);
  }

  throw new Error('❌ Facebook videos cannot be downloaded due to Facebook\'s strict anti-bot protection. Try downloading from TikTok, Instagram, YouTube, or Twitter instead!');
}

