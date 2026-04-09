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
};
