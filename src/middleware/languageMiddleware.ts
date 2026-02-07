import { Context, MiddlewareFn } from 'telegraf';
import { hasSelectedLanguage } from '../services/userService.js';
import { logger } from '../utils/logger.js';

export const languageMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;

  if (!userId) {
    return next();
  }

  // Skip language check for /start command and callback queries
  if (ctx.message && 'text' in ctx.message && ctx.message.text === '/start') {
    return next();
  }

  if (ctx.callbackQuery) {
    return next();
  }

  // Check if user has selected language
  if (!hasSelectedLanguage(userId)) {
    logger.info(`User ${userId} has not selected language, redirecting to /start`);
    await ctx.reply('Please use /start to select your language first.');
    return; // Don't proceed
  }

  return next();
};
