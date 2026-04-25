export enum Language {
  KHMER = 'km',
  ENGLISH = 'en',
}

export enum Platform {
  YOUTUBE = 'youtube',
  TIKTOK = 'tiktok',
  DOUYIN = 'douyin',
  INSTAGRAM = 'instagram',
  FACEBOOK = 'facebook',
  TWITTER = 'twitter',
  UNKNOWN = 'unknown',
}

export enum JobStatus {
  QUEUED = 'queued',
  DOWNLOADING = 'downloading',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface UserPreference {
  userId: number;
  language: Language;
  chatId: number;
}

export interface DownloadJob {
  id: string;
  url: string;
  platform: Platform;
  userId: number;
  chatId: number;
  messageId: number;
  status: JobStatus;
  filePath?: string;
  error?: string;
  createdAt: Date;
  /** For inline mode: replace placeholder in chat with downloaded video */
  inlineMessageId?: string;
  /** Optional inline keyboard to attach when replacing inline media. */
  inlineReplyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface VideoInfo {
  title: string;
  duration?: number;
  platform: Platform;
  thumbnail?: string;
  /** Caption/description (e.g. TikTok) */
  description?: string;
}

export interface RateLimitEntry {
  userId: number;
  timestamps: number[];
}
