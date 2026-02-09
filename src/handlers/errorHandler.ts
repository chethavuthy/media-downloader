import { Context } from 'telegraf';
import { VideoDownloadError } from '../services/videoService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';

export async function handleError(ctx: Context, error: Error): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId) {
    return;
  }

  logger.error(`Error for user ${userId}`, error);

  let messageKey: any = 'downloadFailed';

  if (error instanceof VideoDownloadError) {
    switch (error.code) {
      case 'PRIVATE':
        messageKey = 'privateVideo';
        break;
      case 'GEO_RESTRICTED':
        messageKey = 'geoRestricted';
        break;
      case 'UNSUPPORTED':
        messageKey = 'unsupportedPlatform';
        break;
      case 'TIMEOUT':
        messageKey = 'timeout';
        break;
      default:
        messageKey = 'downloadFailed';
    }
  }

  try {
    if (messageKey === 'downloadFailed') {
      const { getRandomFailedReaction } = await import('../utils/reactions.js');
      const failedReaction = getRandomFailedReaction();
      await (ctx as any).react([{ type: 'emoji', emoji: failedReaction as any }]).catch(() => { });
      // Suppress text message for downloadFailed as requested
      return;
    }
    await ctx.reply(getText(userId, messageKey));
  } catch (replyError) {
    logger.error('Failed to send error message', replyError as Error);
  }
}
