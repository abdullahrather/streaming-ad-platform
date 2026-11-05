import { useCallback, useEffect, useRef, useState } from 'react';
import type { Range } from './api';

const REFRESH_MS = 5000;

export const RANGES = [
  { id: '24h', label: '24 hours', hours: 24 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
  { id: '30d', label: '30 days', hours: 24 * 30 },
];

/** What a range is compared with, such as "previous 7 days". */
export const previousLabel = (id: string): string =>
  `previous ${RANGES.find((range) => range.id === id)?.label ?? 'period'}`;

export const rangeFor = (id: string): Range => {
  const hours = RANGES.find((range) => range.id === id)?.hours ?? 24 * 7;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  // Daily charts start on a full day, so the first point isn't a false dip.
  if (hours > 72) from.setUTCHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
};

/**
 * Loads data and refreshes it every few seconds. The previous result stays on
 * screen during a refresh, so the page never flashes back to a loading state.
 */
export const useLiveData = <T>(
  load: () => Promise<T>,
  key: string,
): { data: T | null; error: string; refresh: () => void } => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const loader = useRef(load);
  loader.current = load;

  const refresh = useCallback(() => {
    loader
      .current()
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [key, refresh]);

  return { data, error, refresh };
};

const THEME_KEY = 'campaign-analytics-theme';

export const useTheme = (): { theme: string; toggle: () => void } => {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) return saved;
    } catch {
      // Falls back to the system preference.
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The choice then lasts for this visit.
    }
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
};
