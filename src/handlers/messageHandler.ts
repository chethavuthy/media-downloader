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
      await ctx.react(randomReaction as any);
    } catch (e) {
      logger.error('Failed to send reaction', e as Error);
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
      // Download video
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

      // Send media to user
      if (isPhoto) {
        // Change action to photo if applicable
        await telegram.sendChatAction(job.chatId, 'upload_photo').catch(() => {});
        
        await telegram.sendPhoto(job.chatId, { source: actualPath }, {
          caption: caption,
          reply_parameters: { message_id: job.messageId },
        });
      } else {
        await telegram.sendVideo(job.chatId, { source: actualPath }, {
          caption: caption,
          reply_parameters: { message_id: job.messageId },
        });
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
