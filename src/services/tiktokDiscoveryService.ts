import { config } from '../config/index.js';
import { askGemini } from './aiService.js';
import { logger } from '../utils/logger.js';

export type TikTokDiscoveryMode = 'web' | 'ai' | 'scrap';

interface SearchResultRow {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: SearchResultRow[];
  };
}

interface TavilySearchResponse {
  results?: SearchResultRow[];
}

const FIND_TIKTOK_PREFIX = /^find\s+(?:me\s+)?(?:a\s+|some\s+)?(?:tiktok|tik\s?tok)\b[:\-]?\s*/i;
const TIKTOK_VIDEO_PATH = /^\/@[^/]+\/video\/\d+/i;
const TIKTOK_URL_PATTERN = /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s"'<>\\)]+/gi;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function cleanQuery(query: string): string {
  return query
    .replace(/^find\s+/i, '')
    .replace(/\btik\s?tok\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function extractTikTokFindQuery(query: string): string | null {
  const trimmed = query.trim();
  const matched = trimmed.match(FIND_TIKTOK_PREFIX);
  if (!matched) return null;

  const search = trimmed.slice(matched[0].length).trim();
  return search || null;
}

export function buildTikTokWebSearchQuery(query: string): string {
  const search = cleanQuery(query);
  return `site:tiktok.com ${search}`.trim();
}

function normalizeTikTokCandidateUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('tiktok.com')) return null;
    const isShortLink = host === 'vt.tiktok.com' || host === 'vm.tiktok.com';
    if (!isShortLink && !TIKTOK_VIDEO_PATH.test(parsed.pathname)) return null;

    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function selectBestTikTokUrl(urls: string[]): string | null {
  return selectNextTikTokUrl(urls, []);
}

export function selectNextTikTokUrl(urls: string[], excludedUrls: string[]): string | null {
  const excluded = new Set(excludedUrls.map(normalizeTikTokCandidateUrl).filter(Boolean));

  for (const raw of unique(urls)) {
    const normalized = normalizeTikTokCandidateUrl(raw);
    if (normalized && !excluded.has(normalized)) return normalized;
  }

  return null;
}

function extractTikTokUrls(text: string): string[] {
  return unique(text.match(TIKTOK_URL_PATTERN) || []);
}

async function rewriteTikTokQueryWithAi(query: string): Promise<string> {
  try {
    const result = await askGemini([
      'Rewrite this into a short TikTok search query.',
      'Return only keywords, no explanation, no bullets, no quotes.',
      `User query: ${query}`,
    ].join('\n'));

    const rewritten = cleanQuery(result.answer)
      .replace(/[•\n\r]+/g, ' ')
      .replace(/\[[0-9]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return rewritten || cleanQuery(query);
  } catch (error) {
    logger.warn(`TikTok AI query rewrite failed: ${error instanceof Error ? error.message : String(error)}`);
    return cleanQuery(query);
  }
}

async function searchBrave(query: string): Promise<string[]> {
  if (!config.braveApiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const url = new URL(`${normalizeBaseUrl(config.braveApiBaseUrl)}/web/search`);
  url.searchParams.set('q', buildTikTokWebSearchQuery(query));
  url.searchParams.set('count', String(Math.max(3, config.aiMaxSearchResults)));

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.braveApiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) return [];
    const payload = (await response.json()) as BraveSearchResponse;
    return (payload.web?.results || []).flatMap((row) => [
      row.url || '',
      ...extractTikTokUrls(`${row.title || ''} ${row.description || ''}`),
    ]);
  } catch (error) {
    logger.warn(`TikTok Brave search failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchTavily(query: string): Promise<string[]> {
  if (!config.tavilyApiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${normalizeBaseUrl(config.tavilyApiBaseUrl)}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query: buildTikTokWebSearchQuery(query),
        search_depth: 'basic',
        max_results: Math.max(3, config.aiMaxSearchResults),
      }),
      signal: controller.signal,
    });

    if (!response.ok) return [];
    const payload = (await response.json()) as TavilySearchResponse;
    return (payload.results || []).flatMap((row) => [
      row.url || '',
      ...extractTikTokUrls(`${row.title || ''} ${row.content || ''}`),
    ]);
  } catch (error) {
    logger.warn(`TikTok Tavily search failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeTikTokSearch(query: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const url = new URL('https://www.tiktok.com/search/video');
  url.searchParams.set('q', cleanQuery(query));

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClipSniperBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });

    if (!response.ok) return [];
    return extractTikTokUrls(await response.text());
  } catch (error) {
    logger.warn(`TikTok scrape search failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWeb(query: string): Promise<string[]> {
  const [braveUrls, tavilyUrls] = await Promise.all([
    searchBrave(query),
    searchTavily(query),
  ]);
  return unique([...braveUrls, ...tavilyUrls]);
}

export async function findTikTokVideoUrl(
  query: string,
  mode: TikTokDiscoveryMode,
  excludedUrls: string[] = []
): Promise<string> {
  const baseQuery = extractTikTokFindQuery(query) || query.trim();
  if (!baseQuery) {
    throw new Error('TikTok search query is empty');
  }

  let urls: string[] = [];
  if (mode === 'ai') {
    const rewritten = await rewriteTikTokQueryWithAi(baseQuery);
    urls = await searchWeb(rewritten);
  } else if (mode === 'scrap') {
    urls = await scrapeTikTokSearch(baseQuery);
    if (!selectNextTikTokUrl(urls, excludedUrls)) {
      urls = [...urls, ...(await searchWeb(baseQuery))];
    }
  } else {
    urls = await searchWeb(baseQuery);
  }

  const selected = selectNextTikTokUrl(urls, excludedUrls);
  if (!selected) {
    throw new Error('No TikTok video found');
  }

  return selected;
}
