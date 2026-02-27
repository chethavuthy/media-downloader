import { config } from '../config/index.js';

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<number, RateLimitEntry>();

/**
 * Atomically check whether a user is within their rate limit AND record the
 * request if allowed. Combining check + record into one operation prevents the
 * TOCTOU race condition where two concurrent requests both pass the check
 * before either is recorded.
 *
 * Returns `true` if the request is allowed (and has been recorded).
 * Returns `false` if the user has exceeded their limit (nothing is recorded).
 */
export function checkAndRecordRequest(userId: number): boolean {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;

  const entry = rateLimitMap.get(userId);

  if (!entry) {
    // First ever request — allow and record
    rateLimitMap.set(userId, { timestamps: [now] });
    return true;
  }

  // Prune timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter(ts => now - ts < windowMs);

  if (entry.timestamps.length >= config.maxDownloadsPerUser) {
    return false; // Limit exceeded — do NOT record
  }

  // Within limit — record and allow
  entry.timestamps.push(now);
  return true;
}

/**
 * @deprecated Use checkAndRecordRequest() instead. This function is kept only
 * for backwards compatibility and MUST NOT be used alongside recordRequest() as
 * a two-step check — doing so creates a TOCTOU race condition.
 */
export function checkRateLimit(userId: number): boolean {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  const entry = rateLimitMap.get(userId);
  if (!entry) return true;
  entry.timestamps = entry.timestamps.filter(ts => now - ts < windowMs);
  return entry.timestamps.length < config.maxDownloadsPerUser;
}

/**
 * @deprecated Use checkAndRecordRequest() instead.
 */
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
  if (!entry) return config.maxDownloadsPerUser;
  const recentRequests = entry.timestamps.filter(ts => now - ts < windowMs).length;
  return Math.max(0, config.maxDownloadsPerUser - recentRequests);
}

export function getTimeUntilReset(userId: number): number {
  const now = Date.now();
  const windowMs = config.rateLimitWindowMinutes * 60 * 1000;
  const entry = rateLimitMap.get(userId);
  if (!entry || entry.timestamps.length === 0) return 0;
  const oldestTimestamp = Math.min(...entry.timestamps);
  return Math.max(0, oldestTimestamp + windowMs - now);
}
