import { Context } from 'telegraf';
import { randomUUID } from 'crypto';
import { DownloadJob, JobStatus } from '../types/index.js';
import { extractUrls, isVideoUrl, normalizeUrl, detectPlatform } from '../utils/urlDetector.js';
import { validateUrl } from '../services/videoService.js';
import { queueService } from '../services/queueService.js';
import { getText } from '../locales/index.js';
import { logger } from '../utils/logger.js';
import { checkRateLimit, recordRequest } from '../services/rateLimitService.js';
import { config } from '../config/index.js';
import { askGemini, askBrave, askTavily } from '../services/aiService.js';

const ASK_AI_PREFIX = /^ask\s+(?:ai|grok|gemini|brave|deep|tavily)\b[:\-]?\s*/i;
const INLINE_RESULT_ID_VIDEO = 'download_video';
const INLINE_RESULT_ID_ASK_GEMINI = 'ask_gemini';
const INLINE_RESULT_ID_ASK_BRAVE = 'ask_brave';
const INLINE_RESULT_ID_ASK_TAVILY = 'ask_tavily';
const MAX_PLACEHOLDER_QUESTION_LENGTH = 220;
const MAX_ANSWER_LENGTH = 3800;
const MAX_LINKS = 5;
const HTML_TEXT_OPTIONS = {
  parse_mode: 'HTML' as const,
  disable_web_page_preview: true,
};

function parseAiQuestion(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const matched = trimmed.match(ASK_AI_PREFIX);
  if (!matched) return trimmed;

  const question = trimmed.slice(matched[0].length).trim();
  return question || null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function compactQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BOLD_OPEN = '\x01B_OPEN\x01';
const BOLD_CLOSE = '\x01B_CLOSE\x01';

function cleanupAiMarkdown(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
    .replace(/__(.*?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function restoreBoldTags(escaped: string): string {
  return escaped
    .replace(/\x01B_OPEN\x01/g, '<b>')
    .replace(/\x01B_CLOSE\x01/g, '</b>');
}

function safeHref(url: string): string {
  try {
    return new URL(url).toString().replace(/"/g, '%22');
  } catch {
    return '';
  }
}

function isUsefulSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host.includes('vertexaisearch.cloud.google.com')) return false;
    if (host === 'google.com' || host.endsWith('.google.com')) {
      const q = (parsed.searchParams.get('q') || '').toLowerCase();
      if (q.includes('time in') || q.includes('santuk')) return false;
      return false;
    }
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

type AiMode = 'gemini' | 'brave' | 'tavily';

const MODE_TITLE: Record<AiMode, string> = {
  gemini: '✨ <b>Ask Gemini</b>',
  brave: '🌐 <b>Web Search</b>',
  tavily: '🔍 <b>Deep Search</b>',
};

const MODE_STATUS: Record<AiMode, string> = {
  gemini: '⏳ Gemini is thinking...',
  brave: '⏳ Searching the web...',
  tavily: '⏳ Deep searching...',
};

function buildAiPlaceholder(mode: AiMode, question: string): string {
  const compact = escapeHtml(truncate(compactQuestion(question), MAX_PLACEHOLDER_QUESTION_LENGTH));
  return `${MODE_TITLE[mode]}\n<b>Q:</b> ${compact}\n\n${MODE_STATUS[mode]}`;
}

function injectInlineCitations(escapedText: string, linkUrls: string[]): string {
  return escapedText.replace(/\[(\d+)\]/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1;
    if (idx < 0 || idx >= linkUrls.length) return match;
    const href = safeHref(linkUrls[idx]);
    if (!href) return match;
    return `<a href="${href}">[${numStr}]</a>`;
  });
}

function formatAiReply(
  mode: AiMode,
  question: string,
  answer: string,
  links: string[] | undefined,
  provider: string,
): string {
  const title = MODE_TITLE[mode];
  const questionLine = escapeHtml(truncate(compactQuestion(question), MAX_PLACEHOLDER_QUESTION_LENGTH));
  const cleanedAnswer = cleanupAiMarkdown(answer);
  const uniqueLinks = Array.from(new Set((links || []).filter(isUsefulSourceUrl))).slice(0, MAX_LINKS);
  const escapedAnswer = escapeHtml(truncate(cleanedAnswer, MAX_ANSWER_LENGTH));
  const withBold = restoreBoldTags(escapedAnswer);
  const answerWithCitations = injectInlineCitations(withBold, uniqueLinks);
  const parts = [
    title,
    `<b>Q:</b> ${questionLine}`,
    '',
    answerWithCitations,
    '',
    `<i>${escapeHtml(provider)}</i>`,
  ];
  return parts.join('\n');
}

function getAiErrorMessage(_mode: AiMode, error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const lower = message.toLowerCase();

  if (lower.includes('not configured')) {
    return '❌ Service not configured. Check API keys.';
  }
  if (lower.includes('timed out')) {
    return '⏱️ Request timed out. Please try again.';
  }
  if (lower.includes('all providers failed')) {
    return '❌ All search providers failed. Please try again later.';
  }
  return '❌ Failed to get answer. Please try again.';
}

async function handleAiInlineResult(
  ctx: Context,
  userId: number,
  question: string,
  mode: AiMode,
  inlineMessageId?: string
): Promise<void> {
  if (!checkRateLimit(userId)) {
    logger.warn(`Inline AI rate limit exceeded for user ${userId}`);
    await ctx.telegram.sendMessage(userId, getText(userId, 'rateLimitExceeded'));
    return;
  }

  recordRequest(userId);

  try {
    let result;
    if (mode === 'tavily') {
      result = await askTavily(question);
    } else if (mode === 'brave') {
      result = await askBrave(question);
    } else {
      result = await askGemini(question);
    }
    const text = formatAiReply(mode, question, result.answer, result.links, result.provider);

    if (inlineMessageId) {
      await ctx.telegram.editMessageText(undefined, undefined, inlineMessageId, text, HTML_TEXT_OPTIONS);
      return;
    }

    await ctx.telegram.sendMessage(userId, text, HTML_TEXT_OPTIONS);
  } catch (error: unknown) {
    logger.error('Inline AI request failed', error instanceof Error ? error : undefined);
    const message = getAiErrorMessage(mode, error);

    if (inlineMessageId) {
      try {
        await ctx.telegram.editMessageText(undefined, undefined, inlineMessageId, message);
        return;
      } catch (editError: unknown) {
        logger.warn(`Failed to edit inline AI error message: ${String(editError)}`);
      }
    }

    await ctx.telegram.sendMessage(userId, message);
  }
}

export async function handleInlineQuery(ctx: Context): Promise<void> {
  const query = ctx.inlineQuery?.query?.trim();
  const userId = ctx.from?.id;

  if (!query || !userId) return;

  const results: any[] = [];
  const aiQuestion = parseAiQuestion(query);
  if (aiQuestion) {
    results.push(
      {
        type: 'article',
        id: INLINE_RESULT_ID_ASK_GEMINI,
        title: '✨ Ask Gemini',
        description: 'Google-powered answer with live sources',
        input_message_content: {
          message_text: buildAiPlaceholder('gemini', aiQuestion),
          parse_mode: 'HTML',
        },
        reply_markup: {
          inline_keyboard: [[{ text: '⏳ Thinking...', callback_data: randomUUID() }]],
        },
      },
      {
        type: 'article',
        id: INLINE_RESULT_ID_ASK_BRAVE,
        title: '🌐 Web Search',
        description: 'Brave-powered search with AI summary',
        input_message_content: {
          message_text: buildAiPlaceholder('brave', aiQuestion),
          parse_mode: 'HTML',
        },
        reply_markup: {
          inline_keyboard: [[{ text: '🌐 Searching...', callback_data: randomUUID() }]],
        },
      },
      {
        type: 'article',
        id: INLINE_RESULT_ID_ASK_TAVILY,
        title: '🔍 Deep Search',
        description: 'Tavily deep research with AI summary',
        input_message_content: {
          message_text: buildAiPlaceholder('tavily', aiQuestion),
          parse_mode: 'HTML',
        },
        reply_markup: {
          inline_keyboard: [[{ text: '🔍 Searching...', callback_data: randomUUID() }]],
        },
      }
    );
  }

  const urls = extractUrls(query);
  const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));
  if (url) {
    const normalizedUrl = normalizeUrl(url);
    if (validateUrl(normalizedUrl)) {
      const platform = detectPlatform(normalizedUrl);
      const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
      const PLATFORM_EMOJI: Record<string, string> = {
        tiktok: '📱', douyin: '📱', instagram: '📸',
        facebook: '📘', youtube: '▶️', twitter: '🐦',
      };
      const emoji = PLATFORM_EMOJI[platform] || '📥';
      const placeholderText = `${emoji} ${platformName}\n\n⏳ Downloading your video...`;
      results.unshift({
        type: 'article',
        id: INLINE_RESULT_ID_VIDEO,
        title: `📥 Download ${platformName} video`,
        description: 'Tap — video will appear here',
        input_message_content: {
          message_text: placeholderText,
          parse_mode: 'HTML',
        },
        reply_markup: {
          inline_keyboard: [[{ text: '⏳ Downloading...', callback_data: randomUUID() }]],
        },
      });
    }
  }

  if (!results.length) {
    await ctx.answerInlineQuery([], { cache_time: 0 });
    return;
  }

  await ctx.answerInlineQuery(results, { cache_time: 5 });
}

export async function handleChosenInlineResult(ctx: Context): Promise<void> {
  const chosen = 'chosen_inline_result' in ctx.update ? ctx.update.chosen_inline_result : undefined;
  const userId = ctx.from?.id;
  const inlineMessageId = chosen?.inline_message_id;
  const resultId = chosen?.result_id;

  if (!chosen || !userId) return;

  const query = chosen.query?.trim() || '';
  const aiQuestion = parseAiQuestion(query);
  if (resultId === INLINE_RESULT_ID_ASK_GEMINI && aiQuestion) {
    await handleAiInlineResult(ctx, userId, aiQuestion, 'gemini', inlineMessageId);
    return;
  }
  if (resultId === INLINE_RESULT_ID_ASK_BRAVE && aiQuestion) {
    await handleAiInlineResult(ctx, userId, aiQuestion, 'brave', inlineMessageId);
    return;
  }
  if (resultId === INLINE_RESULT_ID_ASK_TAVILY && aiQuestion) {
    await handleAiInlineResult(ctx, userId, aiQuestion, 'tavily', inlineMessageId);
    return;
  }
  // Backward compatibility: old "Ask <provider> <question>" selections with random result IDs.
  if (ASK_AI_PREFIX.test(query) && aiQuestion) {
    await handleAiInlineResult(ctx, userId, aiQuestion, 'gemini', inlineMessageId);
    return;
  }

  if (!inlineMessageId) {
    logger.warn('chosen_inline_result missing inline_message_id, falling back to PM');
    const urls = extractUrls(query);
    const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));
    if (url) {
      const normalizedUrl = normalizeUrl(url);
      if (validateUrl(normalizedUrl) && checkRateLimit(userId)) {
        recordRequest(userId);
        queueService.addJob({
          id: randomUUID(),
          url: normalizedUrl,
          platform: detectPlatform(normalizedUrl),
          userId,
          chatId: userId,
          messageId: 0,
          status: JobStatus.QUEUED,
          createdAt: new Date(),
        });
      }
    }
    return;
  }

  const urls = extractUrls(query);
  const url = urls.find((u) => isVideoUrl(normalizeUrl(u)));

  if (!url) return;

  const normalizedUrl = normalizeUrl(url);
  if (!validateUrl(normalizedUrl)) {
    await ctx.telegram.sendMessage(userId, getText(userId, 'unsupportedPlatform'));
    return;
  }

  if (!checkRateLimit(userId)) {
    logger.warn(`Inline rate limit exceeded for user ${userId}`);
    await ctx.telegram.sendMessage(userId, getText(userId, 'rateLimitExceeded'));
    return;
  }

  if (!config.mediaChatId) {
    logger.warn('MEDIA_CHAT_ID not set — inline replace disabled, sending to PM');
    const job: DownloadJob = {
      id: randomUUID(),
      url: normalizedUrl,
      platform: detectPlatform(normalizedUrl),
      userId,
      chatId: userId,
      messageId: 0,
      status: JobStatus.QUEUED,
      createdAt: new Date(),
    };
    recordRequest(userId);
    queueService.addJob(job);
    return;
  }

  recordRequest(userId);

  const job: DownloadJob = {
    id: randomUUID(),
    url: normalizedUrl,
    platform: detectPlatform(normalizedUrl),
    userId,
    chatId: userId,
    messageId: 0,
    status: JobStatus.QUEUED,
    createdAt: new Date(),
    inlineMessageId,
  };

  queueService.addJob(job);
  logger.info(`Inline job queued for user ${userId}: ${normalizedUrl.substring(0, 50)}...`);
}
