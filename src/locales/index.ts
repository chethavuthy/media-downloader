import { Language } from '../types/index.js';
import { en } from './en.js';

export type LocaleKey = keyof typeof en;

export function getText(_userId: number, key: LocaleKey): string {
  // User requested to always use English
  return en[key];
}

export { Language };
