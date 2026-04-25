import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegramBotToken: string;
  telegramUseWebhook: boolean;
  telegramWebhookUrl: string;
  telegramWebhookPath: string;
  telegramWebhookSecretToken: string;
  ytDlpPath: string;
  instaloaderPath: string;
  galleryDlPath: string;
  cookiesPath: string;
  maxDownloadsPerUser: number;
  rateLimitWindowMinutes: number;
  maxFileSizeMB: number;
  downloadTimeoutSeconds: number;
  concurrentDownloads: number;
  autoCleanupMinutes: number;
  logLevel: string;
  /** Chat ID to upload video for file_id (for inline replace). Bot must be member. */
  mediaChatId: string;
  /** Bot username for caption mention (e.g. TestClipSn1perBot) */
  botUsername: string;
  /** xAI/OpenAI-compatible API key used for Ask Grok inline mode. */
  grokApiKey: string;
  /** Base URL for Grok-compatible chat completions API. */
  grokApiBaseUrl: string;
  /** Model id for Grok requests. */
  grokModel: string;
  /** Timeout for Grok API calls in milliseconds. */
  grokApiTimeoutMs: number;
  /** Gemini API key for Ask AI inline mode (primary provider). */
  geminiApiKey: string;
  /** Gemini model id for Ask AI requests. */
  geminiModel: string;
  /** Base URL for Gemini REST API. */
  geminiApiBaseUrl: string;
  /** Timeout for Gemini API calls in milliseconds. */
  geminiApiTimeoutMs: number;
  /** Brave Search API key used when Gemini grounding fails. */
  braveApiKey: string;
  /** Base URL for Brave Search API. */
  braveApiBaseUrl: string;
  /** Tavily API key used as secondary search fallback. */
  tavilyApiKey: string;
  /** Base URL for Tavily Search API. */
  tavilyApiBaseUrl: string;
  /** Max number of fallback web search results to include. */
  aiMaxSearchResults: number;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if ((value === undefined || value === '') && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value !== undefined ? value : defaultValue!;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeWebhookPath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

const telegramUseWebhook = getEnvBoolean('TELEGRAM_USE_WEBHOOK', false);
const telegramWebhookPath = normalizeWebhookPath(getEnvVar('TELEGRAM_WEBHOOK_PATH', '/telegram/webhook'));
const telegramWebhookUrl = getEnvVar('TELEGRAM_WEBHOOK_URL', '');

if (telegramUseWebhook && !telegramWebhookUrl) {
  throw new Error('Missing required environment variable: TELEGRAM_WEBHOOK_URL (required when TELEGRAM_USE_WEBHOOK=true)');
}

export const config: Config = {
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  telegramUseWebhook,
  telegramWebhookUrl,
  telegramWebhookPath,
  telegramWebhookSecretToken: getEnvVar('TELEGRAM_WEBHOOK_SECRET_TOKEN', ''),
  ytDlpPath: getEnvVar('YT_DLP_PATH', 'yt-dlp'),
  instaloaderPath: getEnvVar('INSTALOADER_PATH', 'instaloader'),
  galleryDlPath: getEnvVar('GALLERY_DL_PATH', 'gallery-dl'),
  cookiesPath: getEnvVar('COOKIES_PATH', ''),
  maxDownloadsPerUser: getEnvNumber('MAX_DOWNLOADS_PER_USER', 5),
  rateLimitWindowMinutes: getEnvNumber('RATE_LIMIT_WINDOW_MINUTES', 10),
  maxFileSizeMB: getEnvNumber('MAX_FILE_SIZE_MB', 50),
  downloadTimeoutSeconds: getEnvNumber('DOWNLOAD_TIMEOUT_SECONDS', 300),
  concurrentDownloads: getEnvNumber('CONCURRENT_DOWNLOADS', 3),
  autoCleanupMinutes: getEnvNumber('AUTO_CLEANUP_MINUTES', 30),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  mediaChatId: getEnvVar('MEDIA_CHAT_ID', ''),
  botUsername: getEnvVar('BOT_USERNAME', ''),
  grokApiKey: getEnvVar('GROK_API_KEY', ''),
  grokApiBaseUrl: getEnvVar('GROK_API_BASE_URL', 'https://api.x.ai/v1'),
  grokModel: getEnvVar('GROK_MODEL', 'grok-3-mini'),
  grokApiTimeoutMs: getEnvNumber('GROK_API_TIMEOUT_MS', 30000),
  geminiApiKey: getEnvVar('GEMINI_API_KEY', ''),
  geminiModel: getEnvVar('GEMINI_MODEL', 'gemini-2.5-flash'),
  geminiApiBaseUrl: getEnvVar('GEMINI_API_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
  geminiApiTimeoutMs: getEnvNumber('GEMINI_API_TIMEOUT_MS', 30000),
  braveApiKey: getEnvVar('BRAVE_API_KEY', ''),
  braveApiBaseUrl: getEnvVar('BRAVE_API_BASE_URL', 'https://api.search.brave.com/res/v1'),
  tavilyApiKey: getEnvVar('TAVILY_API_KEY', ''),
  tavilyApiBaseUrl: getEnvVar('TAVILY_API_BASE_URL', 'https://api.tavily.com'),
  aiMaxSearchResults: getEnvNumber('AI_MAX_SEARCH_RESULTS', 6),
};
