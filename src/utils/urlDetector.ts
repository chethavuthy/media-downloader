import { Platform } from '../types/index.js';

// URL patterns for different platforms
// Made flexible to catch any media URLs, not just specific formats
const patterns = {
  youtube: /(?:youtube\.com|youtu\.be)/,
  tiktok: /tiktok\.com/,
  douyin: /douyin\.com/,
  instagram: /instagram\.com/,
  facebook: /(?:facebook\.com|fb\.watch)/,
  twitter: /(?:twitter\.com|x\.com)/,
};

export function extractUrls(text: string): string[] {
  // Improved URL extraction regex to exclude trailing punctuation
  const urlRegex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
  const matches = text.match(urlRegex);
  return matches || [];
}

export function detectPlatform(url: string): Platform {
  const normalizedUrl = url.toLowerCase();
  
  if (patterns.youtube.test(normalizedUrl)) {
    return Platform.YOUTUBE;
  }
  if (patterns.tiktok.test(normalizedUrl)) {
    return Platform.TIKTOK;
  }
  if (patterns.douyin.test(normalizedUrl)) {
    return Platform.DOUYIN;
  }
  if (patterns.instagram.test(normalizedUrl)) {
    return Platform.INSTAGRAM;
  }
  if (patterns.facebook.test(normalizedUrl)) {
    return Platform.FACEBOOK;
  }
  if (patterns.twitter.test(normalizedUrl)) {
    return Platform.TWITTER;
  }
  
  return Platform.UNKNOWN;
}

export function isVideoUrl(url: string): boolean {
  return detectPlatform(url) !== Platform.UNKNOWN;
}

export function normalizeUrl(url: string): string {
  // Remove tracking parameters and normalize
  try {
    const urlObj = new URL(url);
    // Remove common tracking parameters
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'igsh'];
    paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
    return urlObj.toString();
  } catch {
    return url;
  }
}
