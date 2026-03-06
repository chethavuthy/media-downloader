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
      description: info.description || info.fulltitle,
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
    const isYouTube = platform === Platform.YOUTUBE;

    // Use specialized Facebook service for better success rate
    // Improved detection for various FB domains (fb.watch, facebok.com, etc.)
    if (isFacebook || url.includes('facebook.com') || url.includes('fb.watch')) {
      logger.info('Delegating to specialized Facebook service');
      const { downloadFacebookVideo } = await import('./facebookService.js');
      return await downloadFacebookVideo(url, outputPath);
    }

    const limit = config.maxFileSizeMB;
    const ytdlFlags: any = {
      output: outputPath,
      // Try to find a version that fits in the size limit and is compatible with Telegram (avc1/h264)
      // Priority: Best AVC/H.264 MP4 under limit -> Best any format under limit -> best
      format: `(bestvideo[vcodec~='^avc1|^h264'][ext=mp4][filesize<${limit}M]+bestaudio[ext=m4a]/best[vcodec~='^avc1|^h264'][ext=mp4][filesize<${limit}M]/best[filesize<${limit}M]/best)`,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      userAgent: (isDouyin || isYouTube)
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        : (isTikTok
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
      maxFilesize: `${limit}M`,
      socketTimeout: config.downloadTimeoutSeconds,
      // Force MP4 container so faststart works (MKV doesn't support it)
      mergeOutputFormat: 'mp4',
      // Ensure video is seekable on Telegram by moving metadata to start of file
      postprocessorArgs: 'ffmpeg:-movflags +faststart'
    };

    // Add cookies if available
    if (config.cookiesPath) {
      ytdlFlags.cookies = config.cookiesPath;
    } else {
      // Use cookies from browser as a fallback for YouTube/TikTok
      if (isYouTube || isTikTok) {
        ytdlFlags.cookiesFromBrowser = 'chrome';
      }
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
      // For TikTok, "unsupported url" usually means it's a photo post that yt-dlp can't handle.
      // Signal this specifically so the caller can retry via the album/gallery-dl path.
      if (detectPlatform(url) === Platform.TIKTOK) {
        throw new VideoDownloadError('TikTok photo post - use album download instead', 'UNSUPPORTED');
      }
      throw new VideoDownloadError('Unsupported platform or format', 'UNSUPPORTED');
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      throw new VideoDownloadError('Download timeout', 'TIMEOUT');
    }

    throw new VideoDownloadError('Download failed', 'UNKNOWN');
  }
}

export { detectPlatform };
