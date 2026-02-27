import { Context } from 'telegraf';
import { VideoDownloadError } from '../services/videoService.js';
import { getText, LocaleKey } from '../locales/index.js';
import { logger } from '../utils/logger.js';
import { getRandomFailedReaction, FAILED_REACTION } from '../utils/reactions.js';

/**
 * Handle a download error in a Telegraf context (used for private-chat
 * errors where a full ctx is available). For job-queue errors (where only
 * the raw Telegram API client is available), see the catch block in
 * messageHandler.setupJobProcessor.
 */
export async function handleError(ctx: Context, error: Error): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId) {
    return;
  }

  logger.error(`Error for user ${userId}`, error);

  const errorCodeToKey: Partial<Record<string, LocaleKey>> = {
    PRIVATE: 'privateVideo',
    GEO_RESTRICTED: 'geoRestricted',
    UNSUPPORTED: 'unsupportedPlatform',
    TIMEOUT: 'timeout',
  };

  let messageKey: LocaleKey = 'downloadFailed';

  if (error instanceof VideoDownloadError && error.code in errorCodeToKey) {
    messageKey = errorCodeToKey[error.code] as LocaleKey;
  }

  try {
    if (messageKey === 'downloadFailed') {
      // Use a reaction for generic failures instead of a text message
      const failedReaction: string = getRandomFailedReaction() ?? FAILED_REACTION;
      await (ctx as Context & { react: (r: unknown) => Promise<void> })
        .react([{ type: 'emoji', emoji: failedReaction }])
        .catch(() => { /* reactions not available in all chat types */ });
      return;
    }
    await ctx.reply(getText(userId, messageKey));
  } catch (replyError) {
    logger.error('Failed to send error message', replyError as Error);
  }
}
