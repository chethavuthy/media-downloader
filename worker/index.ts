import { Container } from '@cloudflare/containers';

type Env = {
  BOT_CONTAINER: DurableObjectNamespace<BotContainer>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_URL: string;
  TELEGRAM_WEBHOOK_PATH: string;
  TELEGRAM_WEBHOOK_SECRET_TOKEN: string;
  BOT_USERNAME: string;
  CONCURRENT_DOWNLOADS: string;
  COOKIES_PATH: string;
  DOWNLOAD_TIMEOUT_SECONDS: string;
  GALLERY_DL_PATH: string;
  INSTALOADER_PATH: string;
  LOG_LEVEL: string;
  MAX_DOWNLOADS_PER_USER: string;
  MAX_FILE_SIZE_MB: string;
  MEDIA_CHAT_ID: string;
  RATE_LIMIT_WINDOW_MINUTES: string;
  YT_DLP_PATH: string;
  AUTO_CLEANUP_MINUTES: string;
};

const CONTAINER_ID = 'clipsniper-bot';

export class BotContainer extends Container<Env> {
  defaultPort = 7860;
  // Keep the container warm because Telegram long polling relies on a live process.
  sleepAfter = '20m';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_USE_WEBHOOK: 'true',
      TELEGRAM_WEBHOOK_URL: env.TELEGRAM_WEBHOOK_URL,
      TELEGRAM_WEBHOOK_PATH: env.TELEGRAM_WEBHOOK_PATH,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      BOT_USERNAME: env.BOT_USERNAME,
      CONCURRENT_DOWNLOADS: env.CONCURRENT_DOWNLOADS,
      COOKIES_PATH: env.COOKIES_PATH,
      DOWNLOAD_TIMEOUT_SECONDS: env.DOWNLOAD_TIMEOUT_SECONDS,
      GALLERY_DL_PATH: env.GALLERY_DL_PATH,
      INSTALOADER_PATH: env.INSTALOADER_PATH,
      LOG_LEVEL: env.LOG_LEVEL,
      MAX_DOWNLOADS_PER_USER: env.MAX_DOWNLOADS_PER_USER,
      MAX_FILE_SIZE_MB: env.MAX_FILE_SIZE_MB,
      MEDIA_CHAT_ID: env.MEDIA_CHAT_ID,
      RATE_LIMIT_WINDOW_MINUTES: env.RATE_LIMIT_WINDOW_MINUTES,
      YT_DLP_PATH: env.YT_DLP_PATH,
      AUTO_CLEANUP_MINUTES: env.AUTO_CLEANUP_MINUTES,
    };
  }
}

function botInstance(env: Env) {
  return env.BOT_CONTAINER.getByName(CONTAINER_ID);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return botInstance(env).fetch(request);
  },
};
