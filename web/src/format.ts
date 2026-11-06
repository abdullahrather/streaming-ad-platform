import { locale, t } from './i18n';

const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(locale);
const euros = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

export const formatCompact = (value: number): string => compact.format(value);
export const formatNumber = (value: number): string => whole.format(value);
export const formatEuros = (cents: number): string => euros.format(cents / 100);
/** To the cent, for balances and invoices. Euros unless another currency is given. */
export const formatMoney = (cents: number, currency = 'EUR'): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
export const formatCpm = (cents: number): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const formatPercent = (value: number, digits = 1): string =>
  new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
/** A number with a fixed number of decimals, such as an average frequency. */
export const formatDecimal = (value: number, digits = 1): string =>
  new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

export const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const formatTick = (value: string, hourly: boolean): string =>
  new Date(value).toLocaleString(
    locale,
    hourly ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  );

export const ROLE_NAMES: Record<string, string> = {
  OWNER: t('Owner'),
  MANAGER: t('Manager'),
  ANALYST: t('Analyst'),
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: t('Owners manage the team and campaigns.'),
  MANAGER: t('Managers run campaigns and can see team activity.'),
  ANALYST: t('Analysts can view campaigns and reports, but not change them.'),
};

export const SLOT_LABELS: Record<string, string> = {
  PRE_ROLL: t('Pre-roll'),
  MID_ROLL: t('Mid-roll'),
  POST_ROLL: t('Post-roll'),
};

export const DEVICE_LABELS: Record<string, string> = {
  CTV: t('Connected TV'),
  MOBILE: t('Mobile'),
  WEB: t('Web'),
  TABLET: t('Tablet'),
};

export const COUNTRY_LABELS: Record<string, string> = {
  AT: t('Austria'),
  DE: t('Germany'),
  ES: t('Spain'),
  FR: t('France'),
  IT: t('Italy'),
  NL: t('Netherlands'),
  SE: t('Sweden'),
};
