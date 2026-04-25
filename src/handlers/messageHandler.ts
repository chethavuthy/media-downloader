import { Context } from 'telegraf';
import { Update } from 'telegraf/types';
import { randomUUID } from 'crypto';
import { DownloadJob, JobStatus } from '../types/index.js';
import { extractUrls, isVideoUrl, normalizeUrl, detectPlatform } from '../utils/urlDetector.js';
import { validateUrl, downloadVideo, getVideoInfo } from '../services/videoService.js';
import { queueService } from '../services/queueService.js';
import { createTempPath, getActualFilePath, validateFileSize, cleanup } from '../services/fileService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';
import { Telegram } from 'telegraf';

import { getRandomReaction, getRandomFailedReaction } from '../utils/reactions.js';
import { downloadAlbum, isAlbum } from '../services/imageService.js';
import { config } from '../config/index.js';
import { Platform } from '../types/index.js';

const CAPTION_MAX = 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCaption(_platform: Platform, info?: { title?: string; description?: string }): string | undefined {
  const desc = (info?.description || info?.title || '').replace(/\s+/g, ' ').trim();
  if (!desc) return undefined;

  const escaped = escapeHtml(desc);
  const tag = 'blockquote';
  const closeTag = 'blockquote';

  const descBlock = `<${tag}>${escaped}</${closeTag}>`;
  if (descBlock.length <= CAPTION_MAX) return descBlock;

  const overhead = CAPTION_MAX - `<${tag}></${closeTag}>`.length - 1;
  if (overhead < 20) return undefined;
  return `<blockquote expandable>${escaped.slice(0, overhead)}…</blockquote>`;
}

export async function handleMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const message = ctx.message;

  if (!userId || !chatId) {
    return;
  }

  const text = 'text' in message ? message.text : ('caption' in message ? message.caption : '');

  if (!text) {
    return;
  }
  const urls = extractUrls(text);

  if (urls.length === 0) {
    return; // No URLs found, ignore
  }

  // Process first valid video URL
  for (const url of urls) {
    const normalizedUrl = normalizeUrl(url);

    if (!isVideoUrl(normalizedUrl)) {
      continue; // Not a video URL, try next
    }

    if (!validateUrl(normalizedUrl)) {
      await ctx.reply(getText(userId, 'unsupportedPlatform'));
      return;
    }

    // Check rate limit ONLY for actual downloads
    const { checkRateLimit, recordRequest } = await import('../services/rateLimitService.js');
    if (!checkRateLimit(userId)) {
      logger.warn(`Rate limit exceeded for user ${userId}`);
      await ctx.reply(getText(userId, 'rateLimitExceeded'));
      return;
    }

    // Record this download request
    recordRequest(userId);

    // Create download job
    const jobId = randomUUID();
    const job: DownloadJob = {
      id: jobId,
      url: normalizedUrl,
      platform: detectPlatform(normalizedUrl),
      userId,
      chatId,
      messageId: message.message_id,
      status: JobStatus.QUEUED,
      createdAt: new Date(),
    };

    // Show bot is uploading/processing
    try {
      await ctx.sendChatAction('upload_video');

      // Add random reaction to the message
      const randomReaction = getRandomReaction();
      try {
        await ctx.react(randomReaction as any);
      } catch (err: any) {
        logger.warn(`Could not send reaction ${randomReaction}: ${err.message}`);
      }
    } catch (e) {
      logger.warn('Failed to setup chat action or reaction');
    }

    // Send acknowledgment (commented out as requested)
    // await ctx.reply(getText(userId, 'downloading'));

    // Add to queue
    queueService.addJob(job);

    return; // Process only first valid URL
  }

  // No valid video URLs found
  await ctx.reply(getText(userId, 'invalidUrl'));
}

// Set up the job processor callback
export function setupJobProcessor(telegram: Telegram): void {
  queueService.setJobCallback(async (job: DownloadJob) => {
    const isInline = !!job.inlineMessageId;
    const actionInterval = isInline ? 0 : setInterval(async () => {
      try {
        await telegram.sendChatAction(job.chatId, 'upload_video');
      } catch (err) {
        // Ignore
      }
    }, 4000);

    try {
      // Check if it's an album/carousel
      const checkAlbum = await isAlbum(job.url);

      if (checkAlbum) {
        logger.info(`Detected album/carousel: ${job.url}`);

        let albumCaption: string | undefined;
        try {
          const info = await getVideoInfo(job.url);
          albumCaption = buildCaption(job.platform, info);
        } catch (e) {
          albumCaption = buildCaption(job.platform);
          logger.warn('Could not get video info for album caption');
        }

        // Download all media from album
        const albumDir = createTempPath(job.id).replace('.%(ext)s', '');
        const mediaFiles = await downloadAlbum(job.url, albumDir);

        if (mediaFiles.length === 0) {
          logger.warn('Album download returned 0 files, assuming it might be a video or single post. Falling back to video/single logic...');
          // Do NOT return here. Let it fall through to the single media download logic below.
        } else {
          logger.info(`Album contains ${mediaFiles.length} items`);

          if (mediaFiles.length === 1) {
            logger.info(`Single item "album" detected, sending as single media`);
            const media = mediaFiles[0];
            if (media.type === 'photo') {
              await telegram.sendPhoto(job.chatId, { source: media.path }, {
                ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
              });
            } else {
              await telegram.sendVideo(job.chatId, { source: media.path }, {
                ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                supports_streaming: true,
                ...(albumCaption ? { caption: albumCaption, parse_mode: 'HTML' as const } : {}),
              });
            }

            await cleanup(albumDir);
            return;
          }

          // Send as media groups (batches of 10)
          const batchSize = 10;

          logger.info(`Starting batch sending for ${mediaFiles.length} items`);

          for (let i = 0; i < mediaFiles.length; i += batchSize) {
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(mediaFiles.length / batchSize);
            const batch = mediaFiles.slice(i, i + batchSize);

            logger.info(`Processing batch ${batchNum}/${totalBatches}: ${batch.length} items`);

            if (batch.length === 1) {
              logger.info(`Sending batch as single media`);
              const media = batch[0];

              if (media.type === 'photo') {
                await telegram.sendPhoto(job.chatId, { source: media.path }, {
                  ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                });
              } else {
                await telegram.sendVideo(job.chatId, { source: media.path }, {
                  ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                  supports_streaming: true,
                  ...(albumCaption ? { caption: albumCaption, parse_mode: 'HTML' as const } : {}),
                });
              }
            } else {
              logger.info(`Sending batch as media group`);
              const mediaGroup = batch.map((media, i) => {
                const cap = albumCaption && i === 0 ? albumCaption : undefined;
                if (media.type === 'photo') {
                  return {
                    type: 'photo',
                    media: { source: media.path },
                    ...(cap ? { caption: cap, parse_mode: 'HTML' as const } : {}),
                  };
                } else {
                  return {
                    type: 'video',
                    media: { source: media.path },
                    supports_streaming: true,
                    ...(cap ? { caption: cap, parse_mode: 'HTML' as const } : {}),
                  };
                }
              });

              await telegram.sendMediaGroup(job.chatId, mediaGroup as any, {
                ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
              });
            }

            // Small delay between batches
            if (i + batchSize < mediaFiles.length) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          // Cleanup the entire album folder
          await cleanup(albumDir);

          logger.info(`Album items (${mediaFiles.length}) sent successfully: ${job.id}`);
          return;
        }
      }

      // Single media download (existing logic)
      const outputPath = createTempPath(job.id);

      try {
        await downloadVideo(job.url, outputPath);
      } catch (videoError: any) {
        // If yt-dlp says "unsupported" for TikTok, it's likely a photo post — retry via album/gallery-dl
        if (videoError.code === 'UNSUPPORTED' && job.url.includes('tiktok.com')) {
          logger.info(`TikTok video download unsupported, retrying as album/photo: ${job.url}`);
          let fallbackCaption: string | undefined;
          try {
            const info = await getVideoInfo(job.url);
            fallbackCaption = buildCaption(job.platform, info);
          } catch (e) {
            fallbackCaption = buildCaption(job.platform);
            logger.warn('Could not get TikTok caption for fallback');
          }
          const albumDir = createTempPath(job.id + '-album').replace('.%(ext)s', '');
          const mediaFiles = await downloadAlbum(job.url, albumDir);

          if (mediaFiles.length > 0) {
            // Send as single or media group (reuse album sending logic)
            if (mediaFiles.length === 1) {
              const media = mediaFiles[0];
              if (media.type === 'photo') {
                await telegram.sendPhoto(job.chatId, { source: media.path }, {
                  ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                });
              } else {
                await telegram.sendVideo(job.chatId, { source: media.path }, {
                  ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                  supports_streaming: true,
                  ...(fallbackCaption ? { caption: fallbackCaption, parse_mode: 'HTML' as const } : {}),
                });
              }
            } else {
              const batchSize = 10;
              for (let i = 0; i < mediaFiles.length; i += batchSize) {
                const batch = mediaFiles.slice(i, i + batchSize);
                if (batch.length === 1) {
                  const media = batch[0];
                  if (media.type === 'photo') {
                    await telegram.sendPhoto(job.chatId, { source: media.path }, {
                      ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                    });
                  } else {
                    await telegram.sendVideo(job.chatId, { source: media.path }, {
                      ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                      supports_streaming: true,
                      ...(fallbackCaption ? { caption: fallbackCaption, parse_mode: 'HTML' as const } : {}),
                    });
                  }
                } else {
                  const mediaGroup = batch.map((media, idx) => ({
                    type: media.type === 'photo' ? 'photo' as const : 'video' as const,
                    media: { source: media.path },
                    ...(media.type === 'video' ? { supports_streaming: true } : {}),
                    ...(fallbackCaption && i === 0 && idx === 0 ? { caption: fallbackCaption, parse_mode: 'HTML' as const } : {}),
                  }));
                  await telegram.sendMediaGroup(job.chatId, mediaGroup as any, {
                    ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
                  });
                }
                if (i + batchSize < mediaFiles.length) {
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              }
            }

            await cleanup(albumDir);
            logger.info(`TikTok photo fallback succeeded: ${job.id}`);
            return;
          }

          // If album download also failed, rethrow original error
          await cleanup(albumDir);
          throw videoError;
        }
        throw videoError;
      }

      // Get actual file path (with real extension)
      const actualPath = await getActualFilePath(outputPath);

      if (!actualPath) {
        throw new Error('Downloaded file not found');
      }

      // Validate file size
      const isValidSize = await validateFileSize(actualPath);
      if (!isValidSize) {
        await cleanup(actualPath);
        await telegram.sendMessage(job.chatId, getText(job.userId, 'fileTooLarge'));
        return;
      }

      // Detect if it's a photo or video based on extension
      const ext = actualPath.split('.').pop()?.toLowerCase();
      const isPhoto = ['jpg', 'jpeg', 'png', 'webp'].includes(ext || '');

      // Get video metadata for Telegram (dimensions and duration)
      let videoWidth: number | undefined;
      let videoHeight: number | undefined;
      let videoDuration: number | undefined;

      if (!isPhoto) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          // Get all metadata in one call to save CPU/processes
          // -select_streams v:0 returns video stream metadata
          // -show_entries allows selecting specific fields
          const { stdout } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration:stream_tags=rotate -show_entries format=duration -of json "${actualPath}"`
          );

          const metadata = JSON.parse(stdout);
          const stream = metadata.streams?.[0];
          const format = metadata.format;

          if (stream) {
            let width = stream.width;
            let height = stream.height;
            const rotation = parseInt(stream.tags?.rotate || '0');

            // Handle rotation
            if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
              [width, height] = [height, width];
              logger.info(`Video rotated ${rotation}°, swapping dimensions: ${width}x${height}`);
            }

            videoWidth = width;
            videoHeight = height;

            // Get duration (prefer stream duration, fallback to format duration)
            const duration = stream.duration || format?.duration;
            if (duration) {
              videoDuration = Math.round(parseFloat(duration));
            }

            logger.info(`Detected video metadata: ${videoWidth}x${videoHeight}, ${videoDuration}s`);
          }
        } catch (err: any) {
          logger.warn(`Could not detect video metadata: ${err.message || err}`);
        }
      }

      let caption: string | undefined;
      try {
        const info = await getVideoInfo(job.url);
        caption = buildCaption(job.platform, info);
      } catch (e) {
        caption = buildCaption(job.platform);
        logger.warn('Could not get video caption');
      }

      // Inline: upload to media chat, get file_id, replace placeholder
      if (isInline && config.mediaChatId && !isPhoto) {
        try {
          const sent = await telegram.sendVideo(config.mediaChatId, { source: actualPath }, {
            supports_streaming: true,
            width: videoWidth,
            height: videoHeight,
            duration: videoDuration,
            ...(caption ? { caption, parse_mode: 'HTML' as const } : {}),
          });
          const fileId = sent.video?.file_id;
          if (fileId) {
            await telegram.editMessageMedia(undefined, undefined, job.inlineMessageId!, {
              type: 'video',
              media: fileId,
              supports_streaming: true,
              width: videoWidth,
              height: videoHeight,
              duration: videoDuration,
              ...(caption ? { caption, parse_mode: 'HTML' as const } : {}),
            }, job.inlineReplyMarkup ? { reply_markup: job.inlineReplyMarkup } : undefined);
          }
        } catch (err) {
          logger.error(`Inline replace failed: ${err}`);
          await telegram.sendMessage(job.chatId, getText(job.userId, 'downloadFailed'));
        }
        await cleanup(actualPath);
        logger.info(`Inline job completed: ${job.id}`);
        return;
      }

      // Regular: send to chat
      const maxRetries = 3;
      let retries = 0;
      let uploadSuccess = false;

      while (retries < maxRetries && !uploadSuccess) {
        try {
          if (isPhoto) {
            await telegram.sendChatAction(job.chatId, 'upload_photo').catch(() => { });
            await telegram.sendPhoto(job.chatId, { source: actualPath }, {
              ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
            });
          } else {
            await telegram.sendVideo(job.chatId, { source: actualPath }, {
              ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
              supports_streaming: true,
              width: videoWidth,
              height: videoHeight,
              duration: videoDuration,
              ...(caption ? { caption, parse_mode: 'HTML' as const } : {}),
            });
          }
          uploadSuccess = true;
        } catch (uploadError: any) {
          retries++;
          const isSslError = uploadError.message?.includes('SSL') || uploadError.message?.includes('ECONNRESET');
          if (retries >= maxRetries) {
            logger.warn(`Upload failed after ${maxRetries} attempts, sending as document`);
            const docCaption = `⚠️ <i>Sent as file due to upload issues</i>`;
            await telegram.sendDocument(job.chatId, { source: actualPath }, {
              caption: docCaption,
              parse_mode: 'HTML' as const,
              ...(job.messageId ? { reply_parameters: { message_id: job.messageId } } : {}),
            });
            uploadSuccess = true;
          } else if (isSslError) {
            await new Promise(resolve => setTimeout(resolve, retries * 2000));
          } else {
            throw uploadError;
          }
        }
      }

      await cleanup(actualPath);
      logger.info(`Job completed successfully: ${job.id}`);
    } catch (error) {
      logger.error(`Job processing failed: ${job.id}`, error as Error);

      // Send error message
      try {
        if (job.messageId) {
          const failedReaction = getRandomFailedReaction();
          await telegram.setMessageReaction(job.chatId, job.messageId, [
            { type: 'emoji', emoji: failedReaction as any }
          ]).catch(() => { });
        } else {
          await telegram.sendMessage(job.chatId, getText(job.userId, 'downloadFailed'));
        }
      } catch (sendError) {
        logger.error('Failed to update reaction on failure', sendError as Error);
      }
    } finally {
      clearInterval(actionInterval);
    }
  });
}
