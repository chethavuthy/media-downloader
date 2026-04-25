import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config/index.js';
import { handleStart } from './handlers/startHandler.js';
import { handleMessage, setupJobProcessor } from './handlers/messageHandler.js';
import { handleGroupMessage } from './handlers/groupHandler.js';
import { handleInlineQuery, handleChosenInlineResult, handleCallbackQuery } from './handlers/inlineHandler.js';
import { scheduleCleanup } from './services/fileService.js';
import { logger } from './utils/logger.js';
import http from 'http';
import dns from 'dns';

function startHealthServer(port: number): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Bot is running!');
    res.end();
  });
  server.listen(port);
  logger.info(`Health check server listening on port ${port}`);
  return server;
}

async function startWebhookServer(bot: Telegraf, port: number): Promise<http.Server> {
  const secretToken = config.telegramWebhookSecretToken || undefined;

  await bot.telegram.setWebhook(
    config.telegramWebhookUrl,
    secretToken ? { secret_token: secretToken } : undefined
  );
  logger.info(`Telegram webhook set: ${config.telegramWebhookUrl}`);

  const webhookHandler = bot.webhookCallback(config.telegramWebhookPath, { secretToken });

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const path = (req.url || '/').split('?')[0] || '/';

    if (method === 'GET' && (path === '/' || path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running!');
      return;
    }

    if (path === config.telegramWebhookPath && method === 'POST') {
      webhookHandler(req, res).catch((error) => {
        logger.error('Webhook handler failed', error as Error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  server.listen(port);

  logger.info(`Webhook server listening on port ${port} path ${config.telegramWebhookPath}`);
  return server;
}

function closeServer(server: http.Server | null, name: string): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close((err) => {
      if (err) {
        logger.warn(`Error while closing ${name}: ${err.message}`);
      } else {
        logger.info(`${name} closed`);
      }
      resolve();
    });
  });
}

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

  const port = parseInt(process.env.PORT || '7860', 10);
  let healthServer: http.Server | null = null;
  let webhookServer: http.Server | null = null;
  let shuttingDown = false;

  // Initialize bot
  const bot = new Telegraf(config.telegramBotToken);

  // Set up job processor
  setupJobProcessor(bot.telegram);

  // Start file cleanup scheduler
  scheduleCleanup();

  // Register handlers
  bot.command('start', handleStart);
  bot.on('inline_query', handleInlineQuery);
  bot.on('chosen_inline_result', handleChosenInlineResult);
  bot.on('callback_query', handleCallbackQuery);

  // Message handlers (rate limiting applied per download, not per message)
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
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${signal} received, stopping bot...`);
    const forceExitTimer = setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(0);
    }, 8000);
    forceExitTimer.unref();

    try {
      bot.stop(signal);
    } catch (error) {
      logger.warn(`bot.stop failed during ${signal}`);
    }

    await Promise.all([
      closeServer(healthServer, 'Health server'),
      closeServer(webhookServer, 'Webhook server'),
    ]);

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  if (config.telegramUseWebhook) {
    webhookServer = await startWebhookServer(bot, port);
    logger.info('Bot is running successfully in webhook mode!');
    return;
  }

  // Polling mode fallback (legacy)
  try {
    // Ensure polling works even if a previous deployment left webhook mode enabled.
    await bot.telegram.deleteWebhook();
    logger.info('Existing Telegram webhook removed for polling mode');
  } catch (error) {
    logger.warn('Could not remove existing webhook before polling startup');
  }

  healthServer = startHealthServer(port);

  // Launch bot with retry logic for network issues
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
