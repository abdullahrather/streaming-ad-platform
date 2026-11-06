/**
 * web/src/i18n.ts
 *
 * The dashboard in English and German. Text is written in English and looked up
 * in the German dictionary, so English needs no dictionary of its own. Changing
 * language reloads the page, which keeps the sign-in and means text built when a
 * file loads, such as label lists, is in the right language too.
 */
import { de } from './locales/de';

export type Language = 'en' | 'de';

export const LANGUAGES: Record<Language, string> = { en: 'English', de: 'Deutsch' };

const STORAGE_KEY = 'language';

const chosen = (): Language => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'de') return saved;
  } catch {
    // Storage can be blocked; the browser's language decides then.
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
};

export const language: Language = chosen();

/** For Intl number and date formatting. */
export const locale = language === 'de' ? 'de-DE' : 'en-GB';

document.documentElement.lang = language;

export const setLanguage = (next: Language): void => {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Without storage the choice can't outlive the reload, so there's nothing to do.
    return;
  }
  window.location.reload();
};

/** Translates English text, filling in {name} placeholders. */
export const t = (text: string, values: Record<string, string | number> = {}): string => {
  const template = (language === 'de' && de[text]) || text;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
};
