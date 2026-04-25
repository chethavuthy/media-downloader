import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface GeminiResponsePart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiResponsePart[];
  };
  groundingMetadata?: {
    groundingChunks?: Array<{
      web?: {
        uri?: string;
      };
    }>;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
  news?: {
    results?: BraveSearchResult[];
  };
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

type QueryIntent = 'news' | 'traffic' | 'events' | 'trading' | 'conflict' | 'general';
type ReplyLanguage = 'km' | 'en';
type SearchProvider = 'gemini' | 'brave' | 'tavily';

export interface AiAnswer {
  answer: string;
  provider: string;
  usedFallback: boolean;
  links?: string[];
}

const PROVIDER_LABELS: Record<SearchProvider, string> = {
  gemini: 'Gemini',
  brave: 'Brave Search',
  tavily: 'Tavily Search',
};

const FALLBACK_CHAINS: Record<SearchProvider, SearchProvider[]> = {
  gemini: ['brave', 'tavily'],
  brave: ['tavily', 'gemini'],
  tavily: ['brave', 'gemini'],
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function extractHttpLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) || [];
  const cleaned = matches
    .map((url) => url.replace(/[)\].,!?;:]+$/, '').trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function mergeLinks(primary: string[], secondary: string[] = [], max = 5): string[] {
  const merged = Array.from(new Set([...primary, ...secondary]));
  return merged.slice(0, Math.max(1, max));
}

function cleanModelAnswer(text: string): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim());

  const kept: string[] = [];
  let skipSourcesSection = false;

  for (const line of lines) {
    if (!line) {
      if (!skipSourcesSection && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }

    if (/^(sources?|links?)\s*:/i.test(line)) {
      skipSourcesSection = true;
      continue;
    }

    if (skipSourcesSection) {
      if (/^\d+\.\s*https?:\/\//i.test(line)) continue;
      if (/^https?:\/\//i.test(line)) continue;
      if (/^\d+\.\s*[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(line)) continue;
      skipSourcesSection = false;
    }

    if (/^provider\s*:/i.test(line)) continue;

    kept.push(line);
  }

  const normalized = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return truncate(normalized, 4000);
}

function normalizedQuestionForSearch(question: string): string {
  return question
    .replace(/\bdeath\s*tol\b/gi, 'death toll')
    .replace(/\bcasualtys\b/gi, 'casualties')
    .replace(/\bupdat\b/gi, 'update')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractGroundingLinks(payload: GeminiResponse): string[] {
  const links: string[] = [];
  for (const candidate of payload.candidates || []) {
    for (const chunk of candidate.groundingMetadata?.groundingChunks || []) {
      const uri = chunk.web?.uri?.trim();
      if (uri) links.push(uri);
    }
  }
  return Array.from(new Set(links));
}

function containsKhmer(text: string): boolean {
  return /[\u1780-\u17FF]/.test(text);
}

function detectReplyLanguage(question: string): ReplyLanguage {
  return containsKhmer(question) ? 'km' : 'en';
}

function detectIntent(question: string): QueryIntent {
  const q = question.toLowerCase();

  if (/(?:traffic|jam|congestion|road|route|accident|rush hour|ចរាចរណ៍|ស្ទះ|ផ្លូវ)/i.test(q)) {
    return 'traffic';
  }
  if (/(?:event|festival|concert|holiday|celebration|khmer new year|sangkran|nokor sangkran|ព្រឹត្តិការណ៍|សង្ក្រាន្ត|កម្មវិធី)/i.test(q)) {
    return 'events';
  }
  if (/(?:trading|trade|stock|crypto|btc|forex|gold|xau|usd|khr|market price|signal|buy|sell|ជួញដូរ|ភាគហ៊ុន|មាស|ដុល្លារ)/i.test(q)) {
    return 'trading';
  }
  if (/(?:news|headline|breaking|trend|update|latest|what is happening|ព័ត៌មាន|កំពុងកើត|ត្រេន)/i.test(q)) {
    return 'news';
  }
  if (/(?:war|conflict|death toll|casualt|killed|dead|strike|attack|iran|israel|gaza|ukraine|russia|usa|united states|china|taiwan)/i.test(q)) {
    return 'conflict';
  }

  return 'general';
}

function includesCambodiaHint(text: string): boolean {
  return /(?:cambodia|khmer|phnom penh|siem reap|battambang|kampot|sihanoukville|kandal|បម្ពុជា|ភ្នំពេញ|សៀមរាប)/i.test(text)
    || containsKhmer(text);
}

function phnomPenhNow(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date());
}

function intentFormatGuide(intent: QueryIntent): string {
  if (intent === 'traffic') {
    return 'Format: 1) Current hotspots 2) Suggested alternatives 3) Best travel window in next few hours.';
  }
  if (intent === 'events') {
    return 'Format: 1) Event name 2) Where 3) When 4) Entry/price if known 5) Quick tip.';
  }
  if (intent === 'trading') {
    return 'Format: 1) Current market snapshot 2) Key drivers 3) Risks 4) Neutral next-step checklist. Never give guaranteed returns.';
  }
  if (intent === 'news') {
    return 'Format: Lead with the key headline, then 2-4 updates with specifics, then why it matters.';
  }
  if (intent === 'conflict') {
    return 'Format (required): 1) Death toll / casualty numbers broken down by each side with source attribution e.g. "Country: X,XXX killed (SourceName)[N]" 2) Total regional estimate range 3) One-line uncertainty note with ⚠️. Be specific with numbers.';
  }
  return 'Format: 1-line direct answer, then 4-6 bullet points with specific actionable steps or key facts.';
}

function languageGuide(language: ReplyLanguage): string {
  if (language === 'km') {
    return 'Language: Khmer first. Add a short English summary at the end.';
  }
  return 'Language: English. Use Khmer place/event names when useful.';
}

function mentionsOutsideCambodia(question: string): boolean {
  return /(?:iran|israel|gaza|ukraine|russia|usa|united states|china|taiwan|india|pakistan|europe|africa|middle east|nato|united nations|un\b|world|thailand|vietnam|viet\s?nam|laos|myanmar|burma|malaysia|indonesia|philippines|singapore|japan|korea|australia|uk|united kingdom|france|germany|brazil|mexico|canada|egypt|saudi|turkey|bangladesh)/i
    .test(question);
}

function shouldForceCambodiaContext(question: string, intent: QueryIntent): boolean {
  if (includesCambodiaHint(question)) return false;
  if (mentionsOutsideCambodia(question)) return false;
  if (intent === 'conflict') return false;
  if (intent === 'traffic' || intent === 'events') return true;
  return false;
}

function buildSearchQuery(question: string, intent: QueryIntent): string {
  const normalized = normalizedQuestionForSearch(question);

  if (!shouldForceCambodiaContext(question, intent)) {
    if (intent === 'conflict' && !/(?:death toll|casualt|killed|dead|fatalit|losses)/i.test(normalized)) {
      return `${normalized} latest casualties death toll`;
    }
    return normalized;
  }

  if (intent === 'traffic') return `${normalized} Phnom Penh Cambodia traffic`;
  if (intent === 'events') return `${normalized} Cambodia events`;
  if (intent === 'trading') return `${normalized} Cambodia market`;
  return `${normalized} Cambodia`;
}

type CambodiaContext = 'explicit' | 'location' | 'outside' | 'none';

function detectCambodiaContext(question: string, intent: QueryIntent): CambodiaContext {
  if (mentionsOutsideCambodia(question)) return 'outside';
  if (includesCambodiaHint(question)) return 'explicit';
  if (intent === 'traffic' || intent === 'events') return 'location';
  return 'none';
}

function buildSystemInstruction(intent: QueryIntent, language: ReplyLanguage, cambodiaCtx: CambodiaContext): string {
  const contextGuide: Record<CambodiaContext, string> = {
    explicit: 'User asked about Cambodia. Prioritize Cambodia context.',
    location: 'Default to Cambodia/Phnom Penh for this location-specific question.',
    outside: 'User asked about a specific country/region. Answer for that context, do not force Cambodia.',
    none: 'Answer the question directly. Only mention Cambodia if specifically relevant.',
  };

  return [
    'You are a real-time assistant for Telegram inline responses.',
    contextGuide[cambodiaCtx],
    languageGuide(language),
    intentFormatGuide(intent),
    'STRICT RULES:',
    '1) Use bullet points "•" to structure the answer. Aim for 5-12 lines. Never give a vague 1-2 sentence response.',
    '2) You MUST finish EVERY bullet point and sentence completely. Never stop mid-sentence or mid-number. If you start a bullet, finish it. End with a complete thought.',
    '3) Be specific and actionable. Include numbers, steps, names, or data. Never give generic filler like "it involves a combination of strategies".',
    '4) Cite sources inline using [1], [2], [3] matching the numbered web snippets. Do not add a separate Sources/Links section.',
    '5) Do not use markdown (**, __, #, *). Use "•" for bullets, plain text only.',
    '6) Do NOT start with "As of" or any date/time prefix. Jump straight into the answer.',
    '7) Do not invent facts. If unsure, say what needs verification.',
  ].join(' ');
}

function buildUserPrompt(question: string, intent: QueryIntent, contextSources: WebSource[]): string {
  const contextBlock = contextSources.length
    ? `Recent web snippets:\n${contextSources
        .map((source, index) => `[${index + 1}] ${source.title}\nURL: ${source.url}\n${source.snippet}`)
        .join('\n\n')}\n\n`
    : '';

  const citationHint = contextSources.length
    ? 'Cite sources inline using [1], [2], etc. matching the snippet numbers above. Be specific with data from the snippets.'
    : '';

  return [
    `Current Phnom Penh time: ${phnomPenhNow()}`,
    `Intent: ${intent}`,
    contextBlock,
    citationHint,
    'Return only the final answer text. Do NOT start with "As of" or any timestamp prefix.',
    'Question:',
    question,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function collectGeminiText(payload: GeminiResponse): string {
  const raw = (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return cleanModelAnswer(raw);
}

// ─── API Calls ───────────────────────────────────────────────────────────────

async function callGemini(
  question: string,
  useGoogleSearchTool: boolean,
  contextSources: WebSource[] = []
): Promise<{ answer: string; links: string[] }> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, config.geminiApiTimeoutMs));

  const model = encodeURIComponent(config.geminiModel);
  const baseUrl = normalizeBaseUrl(config.geminiApiBaseUrl);
  const endpoint = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const intent = detectIntent(question);
  const language = detectReplyLanguage(question);
  const cambodiaCtx = detectCambodiaContext(question, intent);
  const prompt = buildUserPrompt(question, intent, contextSources);

  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction(intent, language, cambodiaCtx) }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  if (useGoogleSearchTool) {
    body.tools = [{ google_search: {} }];
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      const snippet = raw.slice(0, 400).replace(/\s+/g, ' ').trim();
      throw new Error(`Gemini API request failed (${response.status}): ${snippet}`);
    }

    let payload: GeminiResponse;
    try {
      payload = JSON.parse(raw) as GeminiResponse;
    } catch {
      throw new Error('Invalid JSON response from Gemini API');
    }

    const answer = collectGeminiText(payload);
    if (!answer) {
      throw new Error('Gemini API returned an empty answer');
    }
    const groundingLinks = extractGroundingLinks(payload);
    return { answer, links: groundingLinks };
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message.toLowerCase().includes('abort')) {
      throw new Error('Gemini API request timed out');
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWithBrave(question: string): Promise<WebSource[]> {
  if (!config.braveApiKey) {
    throw new Error('BRAVE_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const baseUrl = normalizeBaseUrl(config.braveApiBaseUrl);
  const url = new URL(`${baseUrl}/web/search`);
  url.searchParams.set('q', buildSearchQuery(question, detectIntent(question)));
  url.searchParams.set('count', String(Math.max(1, config.aiMaxSearchResults)));

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.braveApiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Brave Search request failed (${response.status})`);
    }

    const payload = (await response.json()) as BraveSearchResponse;
    const rows = [...(payload.news?.results || []), ...(payload.web?.results || [])];

    const unique = new Map<string, WebSource>();
    for (const row of rows) {
      const urlValue = (row.url || '').trim();
      if (!urlValue || unique.has(urlValue)) continue;

      unique.set(urlValue, {
        title: (row.title || 'Untitled').trim(),
        url: urlValue,
        snippet: (row.description || '').trim(),
      });
      if (unique.size >= config.aiMaxSearchResults) break;
    }

    const sources = Array.from(unique.values());
    if (!sources.length) {
      throw new Error('Brave Search returned no results');
    }
    return sources;
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message.toLowerCase().includes('abort')) {
      throw new Error('Brave Search request timed out');
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWithTavily(question: string, advanced = false): Promise<WebSource[]> {
  if (!config.tavilyApiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), advanced ? 25000 : 15000);
  const baseUrl = normalizeBaseUrl(config.tavilyApiBaseUrl);
  const endpoint = `${baseUrl}/search`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query: buildSearchQuery(question, detectIntent(question)),
        search_depth: advanced ? 'advanced' : 'basic',
        max_results: Math.max(1, config.aiMaxSearchResults + (advanced ? 2 : 0)),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily Search request failed (${response.status})`);
    }

    const payload = (await response.json()) as TavilySearchResponse;
    const sources = (payload.results || [])
      .map((row) => ({
        title: (row.title || 'Untitled').trim(),
        url: (row.url || '').trim(),
        snippet: (row.content || '').trim(),
      }))
      .filter((row) => row.url);

    if (!sources.length) {
      throw new Error('Tavily Search returned no results');
    }
    return sources;
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message.toLowerCase().includes('abort')) {
      throw new Error('Tavily Search request timed out');
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Provider dispatch ───────────────────────────────────────────────────────

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatSearchResults(sources: WebSource[], snippetMax = 300): { answer: string; links: string[] } {
  const top = sources.slice(0, 5);
  const bullets = top.map((s, i) => {
    const title = stripHtmlTags(s.title || '').trim();
    const snippet = truncate(stripHtmlTags(s.snippet || '').trim(), snippetMax);
    const parts: string[] = [];
    if (title) parts.push(title);
    if (snippet) parts.push(snippet);
    return `• ${parts.join(' - ')} [${i + 1}]`;
  });
  return {
    answer: bullets.join('\n\n'),
    links: top.map((s) => s.url),
  };
}

async function runProvider(
  provider: SearchProvider,
  question: string,
): Promise<{ answer: string; links: string[] }> {
  switch (provider) {
    case 'gemini': {
      return callGemini(question, true);
    }
    case 'brave': {
      const sources = await searchWithBrave(question);
      return formatSearchResults(sources);
    }
    case 'tavily': {
      const sources = await searchWithTavily(question, true);
      return formatSearchResults(sources, 200);
    }
  }
}

async function askWithFallback(primary: SearchProvider, question: string): Promise<AiAnswer> {
  const chain = [primary, ...FALLBACK_CHAINS[primary]];
  const errors: string[] = [];

  for (const provider of chain) {
    try {
      const result = await runProvider(provider, question);
      const isFallback = provider !== primary;
      return {
        answer: result.answer,
        provider: PROVIDER_LABELS[provider],
        usedFallback: isFallback,
        links: mergeLinks(result.links, extractHttpLinks(result.answer)),
      };
    } catch (error: unknown) {
      const msg = errorMessage(error);
      errors.push(`${PROVIDER_LABELS[provider]}: ${msg}`);
      logger.warn(`${PROVIDER_LABELS[provider]} failed: ${msg}`);
    }
  }

  throw new Error(`All providers failed. ${errors.join(' | ')}`.trim());
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function askGemini(prompt: string): Promise<AiAnswer> {
  const question = prompt.trim();
  if (!question) throw new Error('Question is empty');
  return askWithFallback('gemini', question);
}

export async function askBrave(prompt: string): Promise<AiAnswer> {
  const question = prompt.trim();
  if (!question) throw new Error('Question is empty');
  return askWithFallback('brave', question);
}

export async function askTavily(prompt: string): Promise<AiAnswer> {
  const question = prompt.trim();
  if (!question) throw new Error('Question is empty');
  return askWithFallback('tavily', question);
}
