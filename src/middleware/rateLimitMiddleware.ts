import { Context, MiddlewareFn } from 'telegraf';
import { checkRateLimit, recordRequest } from '../services/rateLimitService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';

export const rateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;

  if (!userId) {
    return next();
  }

  // Check rate limit
  if (!checkRateLimit(userId)) {
    logger.warn(`Rate limit exceeded for user ${userId}`);
    
    await ctx.reply(getText(userId, 'rateLimitExceeded'));
    return; // Don't proceed
  }

  // Record this request
  recordRequest(userId);

  return next();
};
