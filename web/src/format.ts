const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
const euros = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

export const formatCompact = (value: number): string => compact.format(value);
export const formatNumber = (value: number): string => whole.format(value);
export const formatEuros = (cents: number): string => euros.format(cents / 100);
const exactEuros = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' });
/** To the cent, for balances and invoices. */
export const formatMoney = (cents: number): string => exactEuros.format(cents / 100);
export const formatCpm = (cents: number): string => `€${(cents / 100).toFixed(2)}`;
export const formatPercent = (value: number, digits = 1): string =>
  `${(value * 100).toFixed(digits)}%`;

export const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const formatTick = (value: string, hourly: boolean): string =>
  new Date(value).toLocaleString(
    'en-GB',
    hourly ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  );

export const ROLE_NAMES: Record<string, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  ANALYST: 'Analyst',
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: 'Owners manage the team and campaigns.',
  MANAGER: 'Managers run campaigns and can see team activity.',
  ANALYST: 'Analysts can view campaigns and reports, but not change them.',
};

export const SLOT_LABELS: Record<string, string> = {
  PRE_ROLL: 'Pre-roll',
  MID_ROLL: 'Mid-roll',
  POST_ROLL: 'Post-roll',
};

export const DEVICE_LABELS: Record<string, string> = {
  CTV: 'Connected TV',
  MOBILE: 'Mobile',
  WEB: 'Web',
  TABLET: 'Tablet',
};

export const COUNTRY_LABELS: Record<string, string> = {
  AT: 'Austria',
  DE: 'Germany',
  ES: 'Spain',
  FR: 'France',
  IT: 'Italy',
  NL: 'Netherlands',
  SE: 'Sweden',
};
