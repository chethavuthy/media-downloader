import { Context } from 'telegraf';
import { Update } from 'telegraf/types';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';

export async function handleStart(ctx: Context<Update.MessageUpdate>): Promise<void> {
  const userId = ctx.from?.id;
  
  if (!userId) {
    return;
  }

  logger.info(`User ${userId} started the bot`);

  // Send welcome message in English directly
  await ctx.reply(getText(userId, 'welcome'), {
    parse_mode: 'Markdown',
  });
}
