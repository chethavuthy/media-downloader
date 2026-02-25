import { Context } from 'telegraf';
import { Update } from 'telegraf/types';
import { randomUUID } from 'crypto';
import { DownloadJob, JobStatus } from '../types/index.js';
import { extractUrls, isVideoUrl, normalizeUrl, detectPlatform } from '../utils/urlDetector.js';
import { queueService } from '../services/queueService.js';
import { getRandomReaction } from '../utils/reactions.js';
import { logger } from '../utils/logger.js';

export async function handleGroupMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
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
    return;
  }

  // Process first valid video URL
  for (const url of urls) {
    const normalizedUrl = normalizeUrl(url);

    if (!isVideoUrl(normalizedUrl)) {
      continue;
    }

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
    } catch (e) {
      logger.error('Failed to send chat action upload_video', e as Error);
    }

    // Add random reaction to the message
    const randomReaction = getRandomReaction();
    try {
      await ctx.react(randomReaction as any);
    } catch (e) {
      logger.error(`Failed to send reaction [${randomReaction}] in group`, e as Error);
    }

    // Send acknowledgment in groups (commented out as requested)
    // await ctx.reply(getText(userId, 'downloading'), {
    //   reply_parameters: { message_id: message.message_id },
    // });

    // Add to queue
    queueService.addJob(job);

    logger.info(`Group video download queued: ${jobId} in chat ${chatId}`);

    return; // Process only first valid URL per message
  }
}
