import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegramBotToken: string;
  ytDlpPath: string;
  instaloaderPath: string;
  galleryDlPath: string;
  maxDownloadsPerUser: number;
  rateLimitWindowMinutes: number;
  maxFileSizeMB: number;
  downloadTimeoutSeconds: number;
  concurrentDownloads: number;
  autoCleanupMinutes: number;
  logLevel: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && !defaultValue) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue!;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

export const config: Config = {
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  ytDlpPath: getEnvVar('YT_DLP_PATH', 'yt-dlp'),
  instaloaderPath: getEnvVar('INSTALOADER_PATH', 'instaloader'),
  galleryDlPath: getEnvVar('GALLERY_DL_PATH', 'gallery-dl'),
  maxDownloadsPerUser: getEnvNumber('MAX_DOWNLOADS_PER_USER', 5),
  rateLimitWindowMinutes: getEnvNumber('RATE_LIMIT_WINDOW_MINUTES', 10),
  maxFileSizeMB: getEnvNumber('MAX_FILE_SIZE_MB', 50),
  downloadTimeoutSeconds: getEnvNumber('DOWNLOAD_TIMEOUT_SECONDS', 300),
  concurrentDownloads: getEnvNumber('CONCURRENT_DOWNLOADS', 3),
  autoCleanupMinutes: getEnvNumber('AUTO_CLEANUP_MINUTES', 30),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
};
