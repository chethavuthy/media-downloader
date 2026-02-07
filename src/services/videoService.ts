import youtubedl from 'youtube-dl-exec';
import { Platform, VideoInfo } from '../types/index.js';
import { detectPlatform } from '../utils/urlDetector.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Use Homebrew yt-dlp or system yt-dlp (configurable via env for deployment)
const ytDlp = youtubedl.create(config.ytDlpPath);

export class VideoDownloadError extends Error {
  constructor(
    message: string,
    public code: 'PRIVATE' | 'GEO_RESTRICTED' | 'UNSUPPORTED' | 'TIMEOUT' | 'UNKNOWN'
  ) {
    super(message);
    this.name = 'VideoDownloadError';
  }
}

export function validateUrl(url: string): boolean {
  const platform = detectPlatform(url);
  return platform !== Platform.UNKNOWN;
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    }) as any;

    return {
      title: info.title || 'Unknown',
      duration: info.duration,
      platform: detectPlatform(url),
      thumbnail: info.thumbnail,
    };
  } catch (error) {
    logger.error('Failed to get video info', error as Error);
    throw new VideoDownloadError('Failed to get video info', 'UNKNOWN');
  }
}

export async function downloadVideo(url: string, outputPath: string): Promise<string> {
  try {
    logger.info(`Starting download: ${url}`);

    const platform = detectPlatform(url);
    const isTikTok = platform === Platform.TIKTOK;
    const isDouyin = platform === Platform.DOUYIN;
    const isFacebook = platform === Platform.FACEBOOK;

    // Use specialized Facebook service for better success rate
    if (isFacebook) {
      const { downloadFacebookVideo } = await import('./facebookService.js');
      return await downloadFacebookVideo(url, outputPath);
    }

    const ytdlFlags: any = {
      output: outputPath,
      format: 'best[ext=mp4]/best',
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      userAgent: isDouyin
        ? 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
        : (isTikTok
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
      maxFilesize: `${config.maxFileSizeMB}M`,
      socketTimeout: config.downloadTimeoutSeconds,
    };

    // Add cookies if available
    if (config.cookiesPath) {
      ytdlFlags.cookies = config.cookiesPath;
    } else {
      ytdlFlags.cookiesFromBrowser = 'chrome';
    }

    await ytDlp(url, ytdlFlags);

    logger.info(`Download completed: ${url}`);

    // Verify file was actually created (yt-dlp can "succeed" without downloading anything)
    const fs = await import('fs/promises');
    const possibleExtensions = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'jpg', 'jpeg', 'png', 'webp'];
    const basePathWithoutExt = outputPath.replace('.%(ext)s', '');
    let fileExists = false;

    for (const ext of possibleExtensions) {
      try {
        await fs.access(`${basePathWithoutExt}.${ext}`);
        fileExists = true;
        break;
      } catch { }
    }


    if (!fileExists) {
      throw new VideoDownloadError('Download completed but no file was created', 'UNKNOWN');
    }

    return outputPath;
  } catch (error: any) {
    logger.error('Download failed', error);

    const errorMessage = error.message?.toLowerCase() || '';

    // Parse error types
    if (errorMessage.includes('private') || errorMessage.includes('unavailable')) {
      throw new VideoDownloadError('Video is private or unavailable', 'PRIVATE');
    }
    if (errorMessage.includes('geo') || errorMessage.includes('not available in your country')) {
      throw new VideoDownloadError('Video is geo-restricted', 'GEO_RESTRICTED');
    }
    if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
      throw new VideoDownloadError('Access denied - video may be private or region-locked', 'GEO_RESTRICTED');
    }
    if (errorMessage.includes('unsupported url') || errorMessage.includes('no video formats')) {
      throw new VideoDownloadError('Unsupported platform or format', 'UNSUPPORTED');
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      throw new VideoDownloadError('Download timeout', 'TIMEOUT');
    }

    throw new VideoDownloadError('Download failed', 'UNKNOWN');
  }
}

export { detectPlatform };
