import { Language } from '../types/index.js';

// In-memory storage for user preferences
const userPreferences = new Map<number, Language>();

export function setUserLanguage(userId: number, language: Language): void {
  userPreferences.set(userId, language);
}

export function getUserLanguage(userId: number): Language {
  return userPreferences.get(userId) || Language.ENGLISH;
}

export function hasSelectedLanguage(userId: number): boolean {
  return userPreferences.has(userId);
}

export function clearUserPreference(userId: number): void {
  userPreferences.delete(userId);
}
