import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const DOWNLOADS_DIR = 'downloads';

// Ensure downloads directory exists
async function ensureDownloadsDir(): Promise<void> {
  try {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  } catch (error) {
    logger.error('Failed to create downloads directory', error as Error);
  }
}

export function createTempPath(jobId: string): string {
  return path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
}

export async function cleanup(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    logger.info(`Cleaned up file: ${filePath}`);
  } catch (error) {
    logger.warn(`Failed to cleanup file: ${filePath}`);
  }
}

export async function validateFileSize(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    return fileSizeMB <= config.maxFileSizeMB;
  } catch (error) {
    logger.error('Failed to check file size', error as Error);
    return false;
  }
}

export async function getActualFilePath(basePath: string): Promise<string | null> {
  // yt-dlp replaces %(ext)s with actual extension
  // Try common video and image extensions
  const extensions = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'jpg', 'jpeg', 'png', 'webp'];
  const basePathWithoutExt = basePath.replace('.%(ext)s', '');
  
  for (const ext of extensions) {
    const fullPath = `${basePathWithoutExt}.${ext}`;
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // File doesn't exist, try next extension
    }
  }
  
  return null;
}

// Schedule periodic cleanup of old files
export function scheduleCleanup(): void {
  const cleanupIntervalMs = config.autoCleanupMinutes * 60 * 1000;
  
  setInterval(async () => {
    try {
      const files = await fs.readdir(DOWNLOADS_DIR);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(DOWNLOADS_DIR, file);
        const stats = await fs.stat(filePath);
        const ageMs = now - stats.mtimeMs;
        
        // Delete files older than cleanup interval
        if (ageMs > cleanupIntervalMs) {
          await cleanup(filePath);
        }
      }
    } catch (error) {
      logger.error('Cleanup task failed', error as Error);
    }
  }, cleanupIntervalMs);
  
  logger.info(`Scheduled cleanup every ${config.autoCleanupMinutes} minutes`);
}

// Initialize
ensureDownloadsDir();
