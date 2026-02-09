import { Context } from 'telegraf';
import { Update } from 'telegraf/types';
import { v4 as uuidv4 } from 'uuid';
import { DownloadJob, JobStatus } from '../types/index.js';
import { extractUrls, isVideoUrl, normalizeUrl, detectPlatform } from '../utils/urlDetector.js';
import { validateUrl, downloadVideo } from '../services/videoService.js';
import { queueService } from '../services/queueService.js';
import { createTempPath, getActualFilePath, validateFileSize, cleanup } from '../services/fileService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';
import { Telegram } from 'telegraf';

import { getRandomReaction } from '../utils/reactions.js';
import { getRandomCompletionPhrase } from '../utils/phrases.js';
import { downloadAlbum, isAlbum } from '../services/imageService.js';

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
    const jobId = uuidv4();
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
    // Keep action alive (actions expire every 5s)
    const actionInterval = setInterval(async () => {
      try {
        // We use upload_video by default for the whole process
        await telegram.sendChatAction(job.chatId, 'upload_video');
      } catch (err) {
        // Ignore errors if action fails
      }
    }, 4000);

    try {
      // Check if it's an album/carousel
      const checkAlbum = await isAlbum(job.url);

      if (checkAlbum) {
        logger.info(`Detected album/carousel: ${job.url}`);

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
            const caption = getRandomCompletionPhrase();

            if (media.type === 'photo') {
              await telegram.sendPhoto(job.chatId, { source: media.path }, {
                caption: caption,
                reply_parameters: { message_id: job.messageId },
              });
            } else {
              await telegram.sendVideo(job.chatId, { source: media.path }, {
                caption: caption,
                reply_parameters: { message_id: job.messageId },
                supports_streaming: true,
              });
            }

            await cleanup(albumDir);
            return;
          }

          // Send as media groups (batches of 10)
          const batchSize = 10;
          const completionPhrase = getRandomCompletionPhrase();

          logger.info(`Starting batch sending for ${mediaFiles.length} items`);

          for (let i = 0; i < mediaFiles.length; i += batchSize) {
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(mediaFiles.length / batchSize);
            const batch = mediaFiles.slice(i, i + batchSize);

            logger.info(`Processing batch ${batchNum}/${totalBatches}: ${batch.length} items`);

            // Generate caption for this batch
            const batchSuffix = totalBatches > 1 ? ` (${batchNum}/${totalBatches})` : '';
            const currentCaption = completionPhrase + batchSuffix;

            if (batch.length === 1) {
              logger.info(`Sending batch as single media`);
              const media = batch[0];

              if (media.type === 'photo') {
                await telegram.sendPhoto(job.chatId, { source: media.path }, {
                  caption: currentCaption,
                  reply_parameters: { message_id: job.messageId },
                });
              } else {
                await telegram.sendVideo(job.chatId, { source: media.path }, {
                  caption: currentCaption,
                  reply_parameters: { message_id: job.messageId },
                  supports_streaming: true,
                });
              }
            } else {
              logger.info(`Sending batch as media group`);
              const mediaGroup = batch.map((media, index) => {
                // Only first item in each batch gets the caption
                const caption = index === 0 ? currentCaption : undefined;

                if (media.type === 'photo') {
                  return {
                    type: 'photo',
                    media: { source: media.path },
                    caption: caption,
                  };
                } else {
                  return {
                    type: 'video',
                    media: { source: media.path },
                    caption: caption,
                    supports_streaming: true,
                  };
                }
              });

              await telegram.sendMediaGroup(job.chatId, mediaGroup as any, {
                reply_parameters: { message_id: job.messageId },
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
      await downloadVideo(job.url, outputPath);

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

      const caption = getRandomCompletionPhrase();

      // Get video dimensions for Telegram (accounting for rotation metadata)
      let videoWidth: number | undefined;
      let videoHeight: number | undefined;

      if (!isPhoto) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          // Get rotation metadata
          const { stdout: rotationCheck } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream_tags=rotate -of default=nw=1:nk=1 "${actualPath}"`
          ).catch(() => ({ stdout: '' }));

          const rotation = parseInt(rotationCheck.trim()) || 0;

          // Get video dimensions
          const { stdout } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${actualPath}"`
          );

          const dimensions = stdout.trim().split('x');
          if (dimensions.length === 2) {
            let width = parseInt(dimensions[0]);
            let height = parseInt(dimensions[1]);

            // If video is rotated 90° or 270°, swap width and height for Telegram
            if (rotation === 90 || rotation === 270 || rotation === -90) {
              [width, height] = [height, width];
              logger.info(`Video rotated ${rotation}°, swapping dimensions: ${width}x${height}`);
            }

            videoWidth = width;
            videoHeight = height;
            logger.info(`Sending video dimensions to Telegram: ${videoWidth}x${videoHeight}`);
          }
        } catch (err: any) {
          logger.warn(`Could not detect video dimensions: ${err.message || err}`);
        }
      }

      // Send media to user with retry logic for SSL errors
      const maxRetries = 3;
      let retries = 0;
      let uploadSuccess = false;

      while (retries < maxRetries && !uploadSuccess) {
        try {
          if (isPhoto) {
            // Change action to photo if applicable
            await telegram.sendChatAction(job.chatId, 'upload_photo').catch(() => { });

            await telegram.sendPhoto(job.chatId, { source: actualPath }, {
              caption: caption,
              reply_parameters: { message_id: job.messageId },
            });
          } else {
            await telegram.sendVideo(job.chatId, { source: actualPath }, {
              caption: caption,
              reply_parameters: { message_id: job.messageId },
              supports_streaming: true,
              width: videoWidth,
              height: videoHeight,
            });
          }
          uploadSuccess = true;
        } catch (uploadError: any) {
          retries++;
          const isSslError = uploadError.message?.includes('SSL') || uploadError.message?.includes('ECONNRESET');

          if (retries >= maxRetries) {
            // If all retries failed, send as document instead
            logger.warn(`Upload failed after ${maxRetries} attempts, sending as document`);
            await telegram.sendDocument(job.chatId, { source: actualPath }, {
              caption: `${caption}\n\n⚠️ Sent as file due to upload issues`,
              reply_parameters: { message_id: job.messageId },
            });
            uploadSuccess = true;
          } else if (isSslError) {
            logger.warn(`SSL error on attempt ${retries}/${maxRetries}, retrying in ${retries * 2}s...`);
            await new Promise(resolve => setTimeout(resolve, retries * 2000));
          } else {
            throw uploadError;
          }
        }
      }

      // Cleanup
      await cleanup(actualPath);

      logger.info(`Job completed successfully: ${job.id}`);
    } catch (error) {
      logger.error(`Job processing failed: ${job.id}`, error as Error);

      // Send error message
      try {
        await telegram.sendMessage(job.chatId, getText(job.userId, 'downloadFailed'));
      } catch (sendError) {
        logger.error('Failed to send error message', sendError as Error);
      }
    } finally {
      clearInterval(actionInterval);
    }
  });
}
