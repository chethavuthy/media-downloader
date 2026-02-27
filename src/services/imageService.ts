/**
 * imageService.ts — thin router/façade.
 *
 * Platform-specific logic lives in dedicated sub-modules:
 *   - instagramService.ts     — Instagram album download + detection
 *   - facebookImageService.ts — Facebook photo download + detection
 *   - tiktokImageService.ts   — TikTok photo carousel detection
 *
 * This file owns:
 *   - DownloadedMedia type (shared by all sub-modules)
 *   - scanForMedia() helper (shared by all sub-modules)
 *   - downloadAlbum() router
 *   - isAlbum() router
 */
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface DownloadedMedia {
  path: string;
  type: 'photo' | 'video';
}

// ─── Shared utilities ────────────────────────────────────────────────────────

/**
 * Recursively scan a directory and return all photo/video files found,
 * filtering out video thumbnail images (same basename as a video file).
 */
export async function scanForMedia(dir: string): Promise<DownloadedMedia[]> {
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
        if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          mediaFiles.push({ path: fullPath, type: 'photo' });
        } else if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) {
          mediaFiles.push({ path: fullPath, type: 'video' });
        }
      }
    }
  }

  await scan(dir);
  mediaFiles.sort((a, b) => a.path.localeCompare(b.path));

  // Remove thumbnail photos that share a basename with a video
  const videoBasenames = new Set(
    mediaFiles.filter(m => m.type === 'video').map(m => path.basename(m.path, path.extname(m.path)))
  );

  return mediaFiles.filter(media => {
    if (media.type === 'photo') {
      const base = path.basename(media.path, path.extname(media.path));
      if (videoBasenames.has(base)) {
        logger.info(`Skipping thumbnail photo: ${media.path}`);
        return false;
      }
    }
    return true;
  });
}

// ─── Router: downloadAlbum ────────────────────────────────────────────────────

/**
 * Download all media items from a URL that has been identified as an album or
 * photo post. Dispatches to the appropriate platform-specific service.
 */
export async function downloadAlbum(url: string, outputDir: string): Promise<DownloadedMedia[]> {
  logger.info(`Downloading album from: ${url}`);
  await fs.mkdir(outputDir, { recursive: true });

  try {
    if (url.includes('instagram.com')) {
      const { downloadInstagramAlbum } = await import('./instagramService.js');
      return await downloadInstagramAlbum(url, outputDir);
    }

    if (url.includes('facebook.com') || url.includes('fb.com')) {
      const { downloadFacebookAlbum } = await import('./facebookImageService.js');
      return await downloadFacebookAlbum(url, outputDir);
    }

    if (url.includes('tiktok.com')) {
      const { downloadTikTokAlbum } = await import('./tiktokImageService.js');
      return await downloadTikTokAlbum(url, outputDir);
    }

    // Generic fallback: use yt-dlp
    logger.info('Using yt-dlp for generic album download');
    const outputTemplate = path.join(outputDir, '%(autonumber)s.%(ext)s');
    await execAsync(
      `"${config.ytDlpPath}" "${url}" -o "${outputTemplate}" --no-warnings`,
      { timeout: 120000 }
    );

    const files = await scanForMedia(outputDir);
    if (files.length === 0) {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      throw new Error('No media files found after download');
    }
    return files;
  } catch (error: any) {
    logger.error('Album download failed', error);
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    throw new Error(`Failed to download album: ${error.message}`);
  }
}

// ─── Router: isAlbum ─────────────────────────────────────────────────────────

/**
 * Determine whether a URL points to an album/photo carousel (true) or a single
 * video (false). Dispatches to platform-specific detection logic.
 */
export async function isAlbum(url: string): Promise<boolean> {
  try {
    if (url.includes('instagram.com')) {
      const { isInstagramAlbum } = await import('./instagramService.js');
      return isInstagramAlbum(url);
    }

    if (url.includes('facebook.com') || url.includes('fb.com')) {
      const { isFacebookAlbum } = await import('./facebookImageService.js');
      return isFacebookAlbum(url);
    }

    if (url.includes('tiktok.com')) {
      const { isTikTokAlbum } = await import('./tiktokImageService.js');
      return isTikTokAlbum(url);
    }

    // General detection via yt-dlp
    const { stdout: playlistCheck } = await execAsync(
      `"${config.ytDlpPath}" "${url}" --flat-playlist --print "%(playlist_count)s" --no-warnings 2>&1`,
      { timeout: 10000 }
    ).catch(() => ({ stdout: '' }));

    if (parseInt(playlistCheck.trim()) > 1) return true;

    try {
      const result = await execAsync(
        `"${config.ytDlpPath}" "${url}" --print "%(ext)s" 2>&1`,
        { timeout: 10000 }
      );
      const output = (result.stdout + (result.stderr || '')).toLowerCase();
      if (output.includes('no video') || output.includes('there is no video')) return true;
      const ext = result.stdout.trim().toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
    } catch (error: any) {
      const msg = (error.message || '' + error.stdout || '' + error.stderr || '').toLowerCase();
      return msg.includes('no video') || msg.includes('there is no video');
    }
  } catch {
    return false;
  }
}
