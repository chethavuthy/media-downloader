import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config/index.js';
import { handleStart } from './handlers/startHandler.js';
import { handleMessage, setupJobProcessor } from './handlers/messageHandler.js';
import { handleGroupMessage } from './handlers/groupHandler.js';
import { scheduleCleanup } from './services/fileService.js';
import { rateLimitMiddleware } from './middleware/rateLimitMiddleware.js';
import { logger } from './utils/logger.js';
import http from 'http';
import dns from 'dns';

async function main() {
  logger.info('Starting Telegram Video Downloader Bot...');

  // Manually set DNS servers to bypass platform DNS issues
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
    logger.info('Custom DNS servers configured (Google/Cloudflare)');
  } catch (err) {
    logger.warn('Could not set custom DNS servers, using system default');
  }

  // Pre-flight check: Try to resolve telegram API
  dns.lookup('api.telegram.org', (err, address) => {
    if (err) logger.error('DNS Lookup Test Failed: api.telegram.org could not be resolved');
    else logger.info(`DNS Lookup Test Successful: api.telegram.org resolved to ${address}`);
  });

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

  // Register handlers
  bot.command('start', handleStart);

  // Apply rate limiting middleware to all message events.
  // This is the single authoritative rate-limit gate — the duplicate
  // inline check has been removed from messageHandler.
  bot.use(rateLimitMiddleware);

  // Message handlers
  bot.on([message('text'), message('caption')], async (ctx) => {
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
  const maxRetries = 10;
  let retries = 0;

  // Pre-flight check: Wait for internet to be reachable
  logger.info('Waiting for network to be ready...');

  while (retries < maxRetries) {
    try {
      await bot.launch();
      logger.info('Bot is running successfully!');
      break;
    } catch (error: any) {
      retries++;
      const isDnsError = error.message?.includes('ENOTFOUND') || error.message?.includes('EAI_AGAIN');

      logger.error(`Failed to start bot (Attempt ${retries}/${maxRetries}): ${error.message}`);

      if (retries >= maxRetries) {
        logger.error('CRITICAL: All startup attempts failed.');
        throw error;
      }

      // If it's a DNS error, wait longer
      const baseWait = isDnsError ? 10000 : 5000;
      const waitTime = Math.min(Math.pow(1.5, retries - 1) * baseWait, 60000);

      logger.info(`Retrying in ${Math.round(waitTime / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

main().catch((error) => {
  logger.error('Startup failed:', error);
  // Important: On Hugging Face, don't exit(1) immediately if the health check server is running
  // but let's keep it for now to trigger a Container restart if everything fails
  setTimeout(() => process.exit(1), 5000);
});
