import { config } from '../config/index.js';

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<number, RateLimitEntry>();

export function checkRateLimit(userId: number): boolean {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  
  const entry = rateLimitMap.get(userId);
  
  if (!entry) {
    return true; // First request, allow
  }
  
  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter(ts => now - ts < windowMs);
  
  // Check if under limit
  return entry.timestamps.length < config.maxDownloadsPerUser;
}

export function recordRequest(userId: number): void {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  
  if (entry) {
    entry.timestamps.push(now);
  } else {
    rateLimitMap.set(userId, { timestamps: [now] });
  }
}

export function getRemainingRequests(userId: number): number {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  
  const entry = rateLimitMap.get(userId);
  
  if (!entry) {
    return config.maxDownloadsPerUser;
  }
  
  // Count recent requests
  const recentRequests = entry.timestamps.filter(ts => now - ts < windowMs).length;
  return Math.max(0, config.maxDownloadsPerUser - recentRequests);
}

export function getTimeUntilReset(userId: number): number {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  
  const entry = rateLimitMap.get(userId);
  
  if (!entry || entry.timestamps.length === 0) {
    return 0;
  }
  
  const oldestTimestamp = Math.min(...entry.timestamps);
  const resetTime = oldestTimestamp + windowMs;
  
  return Math.max(0, resetTime - now);
}
