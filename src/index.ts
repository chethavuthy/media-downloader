import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config/index.js';
import { handleStart } from './handlers/startHandler.js';
import { handleMessage, setupJobProcessor } from './handlers/messageHandler.js';
import { handleGroupMessage } from './handlers/groupHandler.js';
import { rateLimitMiddleware } from './middleware/rateLimitMiddleware.js';
import { scheduleCleanup } from './services/fileService.js';
import { logger } from './utils/logger.js';
import http from 'http';

async function main() {
  logger.info('Starting Telegram Video Downloader Bot...');

  // Start a simple dummy HTTP server for health checks (required by some hosting platforms like Hugging Face)
  const port = process.env.PORT || 7860;
  http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Bot is running!');
    res.end();
  }).listen(port);
  logger.info(`Health check server listening on port ${port}`);

  // Initialize bot
  const bot = new Telegraf(config.telegramBotToken);

  // Set up job processor
  setupJobProcessor(bot.telegram);

  // Start file cleanup scheduler
  scheduleCleanup();

  // Register middleware
  bot.use(rateLimitMiddleware);

  // Register handlers
  bot.command('start', handleStart);

  // Message handlers with rate limiting
  bot.on([message('text'), message('caption')], rateLimitMiddleware, async (ctx) => {
    const text = 'text' in ctx.message ? ctx.message.text : ('caption' in ctx.message ? ctx.message.caption : '');
    
    if (!text) return;

    logger.info(`Received msg from ${ctx.from?.id} in ${ctx.chat.type} chat: ${text.substring(0, 50)}...`);
    // Check if group or private
    if (ctx.chat.type === 'private') {
      await handleMessage(ctx as any);
    } else {
      await handleGroupMessage(ctx as any);
    }
  });

  // Error handling
  bot.catch((err, _ctx) => {
    logger.error('Bot error occurred', err as Error);
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('SIGINT received, stopping bot...');
    bot.stop('SIGINT');
  });

  process.once('SIGTERM', () => {
    logger.info('SIGTERM received, stopping bot...');
    bot.stop('SIGTERM');
  });

  // Launch bot with retry logic for network issues (common on Hugging Face)
  const maxRetries = 5;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await bot.launch();
      logger.info('Bot is running!');
      break;
    } catch (error) {
      retries++;
      logger.error(`Failed to start bot (Attempt ${retries}/${maxRetries}):`, error as Error);
      if (retries >= maxRetries) {
        throw error;
      }
      // Wait before retrying (exponential backoff: 5s, 10s, 20s...)
      const waitTime = Math.pow(2, retries - 1) * 5000;
      logger.info(`Retrying in ${waitTime/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

main().catch((error) => {
  logger.error('Final attempt failed, exiting:', error);
  process.exit(1);
});
