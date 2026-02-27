import { Context, MiddlewareFn } from 'telegraf';
import { checkAndRecordRequest } from '../services/rateLimitService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';

export const rateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;

  if (!userId) {
    return next();
  }

  // Atomically check and record — prevents TOCTOU race between check and record
  if (!checkAndRecordRequest(userId)) {
    logger.warn(`Rate limit exceeded for user ${userId}`);
    await ctx.reply(getText(userId, 'rateLimitExceeded'));
    return; // Don't proceed
  }

  return next();
};
