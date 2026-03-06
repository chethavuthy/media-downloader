import { Context } from 'telegraf';
import { randomUUID } from 'crypto';
import { DownloadJob, JobStatus } from '../types/index.js';
import { extractUrls, isVideoUrl, normalizeUrl, detectPlatform } from '../utils/urlDetector.js';
import { validateUrl } from '../services/videoService.js';
import { queueService } from '../services/queueService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';
import { checkRateLimit, recordRequest } from '../services/rateLimitService.js';
import { config } from '../config/index.js';

export async function handleInlineQuery(ctx: Context): Promise<void> {
  const query = ctx.inlineQuery?.query?.trim();
  const userId = ctx.from?.id;

  if (!query || !userId) return;

  const urls = extractUrls(query);
  const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));

  if (!url) {
    await ctx.answerInlineQuery([], { cache_time: 0 });
    return;
  }

  const normalizedUrl = normalizeUrl(url);
  if (!validateUrl(normalizedUrl)) {
    await ctx.answerInlineQuery([], { cache_time: 0 });
    return;
  }

  const platform = detectPlatform(normalizedUrl);
  const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);

  await ctx.answerInlineQuery(
    [
      {
        type: 'article',
        id: randomUUID(),
        title: `📥 Download ${platformLabel} video`,
        description: 'Tap — video will appear here',
        input_message_content: {
          message_text: '⏳ Downloading...',
        },
        reply_markup: {
          inline_keyboard: [[{ text: '⏳ Downloading...', callback_data: randomUUID() }]],
        },
      },
    ],
    { cache_time: 60 }
  );
}

export async function handleChosenInlineResult(ctx: Context): Promise<void> {
  const chosen = 'chosen_inline_result' in ctx.update ? ctx.update.chosen_inline_result : undefined;
  const userId = ctx.from?.id;
  const inlineMessageId = chosen?.inline_message_id;

  if (!chosen || !userId) return;

  if (!inlineMessageId) {
    logger.warn('chosen_inline_result missing inline_message_id, falling back to PM');
    const query = chosen.query?.trim();
    const urls = extractUrls(query || '');
    const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));
    if (url) {
      const normalizedUrl = normalizeUrl(url);
      if (validateUrl(normalizedUrl) && checkRateLimit(userId)) {
        recordRequest(userId);
        queueService.addJob({
          id: randomUUID(),
          url: normalizedUrl,
          platform: detectPlatform(normalizedUrl),
          userId,
          chatId: userId,
          messageId: 0,
          status: JobStatus.QUEUED,
          createdAt: new Date(),
        });
      }
    }
    return;
  }

  const query = chosen.query?.trim();
  const urls = extractUrls(query || '');
  const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));

  if (!url) return;

  const normalizedUrl = normalizeUrl(url);
  if (!validateUrl(normalizedUrl)) {
    await ctx.telegram.sendMessage(userId, getText(userId, 'unsupportedPlatform'));
    return;
  }

  if (!checkRateLimit(userId)) {
    logger.warn(`Inline rate limit exceeded for user ${userId}`);
    await ctx.telegram.sendMessage(userId, getText(userId, 'rateLimitExceeded'));
    return;
  }

  if (!config.mediaChatId) {
    logger.warn('MEDIA_CHAT_ID not set — inline replace disabled, sending to PM');
    const job: DownloadJob = {
      id: randomUUID(),
      url: normalizedUrl,
      platform: detectPlatform(normalizedUrl),
      userId,
      chatId: userId,
      messageId: 0,
      status: JobStatus.QUEUED,
      createdAt: new Date(),
    };
    recordRequest(userId);
    queueService.addJob(job);
    return;
  }

  recordRequest(userId);

  const job: DownloadJob = {
    id: randomUUID(),
    url: normalizedUrl,
    platform: detectPlatform(normalizedUrl),
    userId,
    chatId: userId,
    messageId: 0,
    status: JobStatus.QUEUED,
    createdAt: new Date(),
    inlineMessageId,
  };

  queueService.addJob(job);
  logger.info(`Inline job queued for user ${userId}: ${normalizedUrl.substring(0, 50)}...`);
}
