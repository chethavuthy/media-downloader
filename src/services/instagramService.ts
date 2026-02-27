import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DownloadedMedia, scanForMedia } from './imageService.js';

const execAsync = promisify(exec);

/**
 * Extract Instagram shortcode from URL
 */
export function getInstagramShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Download all media items from an Instagram post/album using instaloader.
 */
export async function downloadInstagramAlbum(url: string, outputDir: string): Promise<DownloadedMedia[]> {
  const shortcode = getInstagramShortcode(url);
  if (!shortcode) throw new Error('Invalid Instagram URL — cannot extract shortcode');

  const cmd = [
    config.instaloaderPath,
    '--no-metadata-json',
    '--no-captions',
    '--no-compress-json',
    `--dirname-pattern=${outputDir}`,
    '--',
    `-${shortcode}`,
  ].join(' ');

  logger.info(`Executing instaloader for shortcode: ${shortcode}`);
  await execAsync(cmd, { timeout: 120000 });

  return scanForMedia(outputDir);
}

/**
 * Returns true if the Instagram URL is a downloadable post/album
 * (not a reel or TV post which are handled by yt-dlp).
 */
export function isInstagramAlbum(url: string): boolean {
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
