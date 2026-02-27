import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { DownloadedMedia, scanForMedia } from './imageService.js';

const execAsync = promisify(exec);

/**
 * Download a TikTok photo carousel using gallery-dl.
 */
export async function downloadTikTokAlbum(url: string, outputDir: string): Promise<DownloadedMedia[]> {
  logger.info('Using gallery-dl for TikTok');
  await execAsync(
    `${config.galleryDlPath} "${url}" --dest "${outputDir}" --no-mtime`,
    { timeout: 120000 }
  );
  return scanForMedia(outputDir);
}

/**
 * Returns true if the TikTok URL is a photo carousel (not a video).
 * Makes a lightweight probe with gallery-dl to determine type.
 */
export async function isTikTokAlbum(url: string): Promise<boolean> {
  // Explicit photo path in URL
  if (url.includes('/photo/')) {
    logger.info('Detected TikTok photo carousel (URL contains /photo/)');
    return true;
  }

  try {
    const { stdout, stderr } = await execAsync(
      `${config.galleryDlPath} "${url}" --get-urls 2>&1`,
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
