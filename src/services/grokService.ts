import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

type GrokMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

interface GrokChatResponse {
  choices?: Array<{
    message?: {
      content?: GrokMessageContent;
    };
  }>;
}

function extractTextContent(content: GrokMessageContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function containsKhmer(text: string): boolean {
  return /[\u1780-\u17FF]/.test(text);
}

function phnomPenhNow(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date());
}

export async function askGrok(prompt: string): Promise<string> {
  const question = prompt.trim();
  if (!question) {
    throw new Error('Question is empty');
  }

  if (!config.grokApiKey) {
    throw new Error('GROK_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, config.grokApiTimeoutMs));
  const baseUrl = config.grokApiBaseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.grokApiKey}`,
      },
      body: JSON.stringify({
        model: config.grokModel,
        messages: [
          {
            role: 'system',
            content: [
              'You are a Cambodia-focused real-time assistant for Telegram inline mode.',
              'Prioritize Cambodia context unless user asks another country explicitly.',
              containsKhmer(question)
                ? 'Reply in Khmer first, then a short English summary.'
                : 'Reply in English, keep phrasing simple for Cambodia users.',
              'For time-sensitive topics, include an "As of" timestamp and avoid stale certainty.',
              'Do not fabricate facts, prices, schedules, or breaking news.',
              'Keep answers practical and concise.',
            ].join(' '),
          },
          {
            role: 'user',
            content: `Current Phnom Penh time: ${phnomPenhNow()}\n\nQuestion: ${question}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      const snippet = raw.slice(0, 400).replace(/\s+/g, ' ').trim();
      logger.warn(`Grok API error ${response.status}: ${snippet}`);
      throw new Error(`Grok API request failed (${response.status})`);
    }

    let payload: GrokChatResponse;
    try {
      payload = JSON.parse(raw) as GrokChatResponse;
    } catch {
      throw new Error('Invalid JSON response from Grok API');
    }

    const answer = extractTextContent(payload.choices?.[0]?.message?.content);
    if (!answer) {
      throw new Error('Grok API returned an empty answer');
    }

    return answer;
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message.includes('aborted') || message.toLowerCase().includes('abort')) {
      throw new Error('Grok API request timed out');
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}
