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
  GROK_API_KEY?: string;
  GROK_API_BASE_URL?: string;
  GROK_MODEL?: string;
  GROK_API_TIMEOUT_MS?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_BASE_URL?: string;
  GEMINI_API_TIMEOUT_MS?: string;
  BRAVE_API_KEY?: string;
  BRAVE_API_BASE_URL?: string;
  TAVILY_API_KEY?: string;
  TAVILY_API_BASE_URL?: string;
  AI_MAX_SEARCH_RESULTS?: string;
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
      GROK_API_KEY: env.GROK_API_KEY || '',
      GROK_API_BASE_URL: env.GROK_API_BASE_URL || 'https://api.x.ai/v1',
      GROK_MODEL: env.GROK_MODEL || 'grok-3-mini',
      GROK_API_TIMEOUT_MS: env.GROK_API_TIMEOUT_MS || '30000',
      GEMINI_API_KEY: env.GEMINI_API_KEY || '',
      GEMINI_MODEL: env.GEMINI_MODEL || 'gemini-2.5-flash',
      GEMINI_API_BASE_URL: env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      GEMINI_API_TIMEOUT_MS: env.GEMINI_API_TIMEOUT_MS || '30000',
      BRAVE_API_KEY: env.BRAVE_API_KEY || '',
      BRAVE_API_BASE_URL: env.BRAVE_API_BASE_URL || 'https://api.search.brave.com/res/v1',
      TAVILY_API_KEY: env.TAVILY_API_KEY || '',
      TAVILY_API_BASE_URL: env.TAVILY_API_BASE_URL || 'https://api.tavily.com',
      AI_MAX_SEARCH_RESULTS: env.AI_MAX_SEARCH_RESULTS || '6',
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
