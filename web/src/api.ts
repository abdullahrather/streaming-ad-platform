export type Status = 'ACTIVE' | 'PAUSED' | 'COMPLETED';
export type Pacing = 'AHEAD' | 'ON_TRACK' | 'BEHIND' | 'NOT_STARTED' | 'FINISHED';
export type OrganisationRole = 'OWNER' | 'MANAGER' | 'ANALYST';

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  twoFactorEnabled: boolean;
  organisationId: string | null;
  organisationRole: OrganisationRole | null;
  alertEmails: boolean;
  organisations: Array<{ id: string; name: string; role: OrganisationRole }>;
}

export interface Totals {
  impressions: number;
  clicks: number;
  firstQuartiles: number;
  midpoints: number;
  thirdQuartiles: number;
  completions: number;
  ctr: number;
  completionRate: number;
}

export interface CampaignInput {
  title: string;
  advertiser: string;
  status?: 'ACTIVE' | 'PAUSED';
  budgetCents: number;
  cpmCents: number;
  impressionGoal: number;
  startsAt: string;
  endsAt: string;
  targetCountries: string[];
  targetGenres: string[];
  targetDevices: string[];
  targetSlots: string[];
  targetSegmentIds: string[];
  deliveryType: 'GUARANTEED' | 'AUCTION';
  pacingMode: 'ASAP' | 'EVEN' | 'CUSTOM';
  dailyBudgetCents: number | null;
  dailyImpressionTarget: number | null;
  frequencyCapPerDay: number | null;
  activeHours: number[];
  activeDays: number[];
  competitiveCategory: string;
}

export interface Forecast {
  availableImpressions: number;
  expectedImpressions: number;
  lowImpressions: number;
  highImpressions: number;
  expectedReach: number;
  averageFrequency: number;
  expectedSpendCents: number;
  goalDeliveryRate: number;
  warnings: string[];
}

export interface Segment {
  id: string;
  name: string;
  genres: string[];
  minViews: number;
}

export interface Campaign extends Totals, Omit<CampaignInput, 'status'> {
  id: string;
  status: Status;
  ownerEmail: string;
  spendCents: number;
  lifetimeImpressions: number;
  lifetimeSpendCents: number;
  deliveryRate: number;
  budgetUsedRate: number;
  pacing: Pacing;
  forecastImpressions: number | null;
  forecastReach: number | null;
}

export interface Point extends Totals {
  time: string;
}

export interface Row extends Totals {
  key: string;
}

export interface CampaignDetail {
  campaign: Campaign;
  timeseries: Point[];
  breakdown: { slot: Row[]; country: Row[]; device: Row[]; show: Row[] };
  filtered: Array<{ reason: string; count: number }>;
  /** Unique viewers in the range. */
  reach: number;
  averageFrequency: number;
  lifetimeReach: number;
  previous: PeriodTotals & { reach: number; averageFrequency: number };
}

export interface PeriodTotals extends Totals {
  spendCents: number;
}

export interface Summary {
  current: PeriodTotals;
  previous: PeriodTotals;
}

export interface Compared {
  campaign: Campaign;
  timeseries: Point[];
  reach: number;
  averageFrequency: number;
}

export type ReportGrouping = 'DAY' | 'CAMPAIGN' | 'SLOT' | 'COUNTRY' | 'DEVICE' | 'SHOW';
export type ReportSchedule = 'NONE' | 'DAILY' | 'WEEKLY';

export interface ReportDefinition {
  campaignIds: string[];
  groupBy: ReportGrouping;
  columns: string[];
  rangeDays: number;
}

export interface SavedReportInput extends ReportDefinition {
  name: string;
  schedule: ReportSchedule;
  sendWeekday: number;
  sendHour: number;
  recipientIds: string[];
}

export interface SavedReport extends SavedReportInput {
  id: string;
  nextRunAt: string | null;
  lastSentAt: string | null;
  createdAt: string;
}

export interface ReportResult {
  from: string;
  to: string;
  groupBy: ReportGrouping;
  columns: string[];
  rows: Array<{ key: string; label: string; values: Record<string, number> }>;
  totals: Record<string, number>;
}

export type AlertType = 'UNDER_DELIVERY' | 'BUDGET_BURN' | 'SUDDEN_DROP';

export interface Alert {
  id: string;
  campaignId: string;
  type: AlertType;
  message: string;
  openedAt: string;
  resolvedAt: string | null;
  details?: { explanation?: string };
  campaign: { title: string; advertiser: string };
}

export interface DiagnosisFactor {
  code: string;
  severity: 'blocker' | 'limit' | 'info';
  title: string;
  detail: string;
  capacity?: number;
}

export interface Diagnosis {
  campaignId: string;
  title: string;
  delivered: number;
  goal: number;
  expectedByNow: number;
  position: number;
  remainingGoal: number;
  remainingDays: number;
  neededPerDay: number;
  recentPerDay: number;
  projectedTotal: number;
  willReachGoal: boolean;
  factors: DiagnosisFactor[];
  summary: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  reason: string;
}

export interface AiAnswer {
  answer: string;
  toolsUsed: string[];
  refused: boolean;
}

export interface Recommendation {
  id: string;
  campaignId: string;
  title: string;
  reason: string;
  change: Record<string, unknown>;
  before: Record<string, unknown>;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'STALE';
  decidedAt: string | null;
  createdAt: string;
}

export interface CampaignDraft {
  input: Partial<CampaignInput>;
  assumptions: string[];
}

export interface AiReview {
  status: 'done' | 'unavailable';
  verdict?: 'looks_fine' | 'needs_attention';
  summary: string;
  issues?: Array<{ kind: string; detail: string }>;
  model: string;
}

export interface Show {
  id: string;
  title: string;
  genre: string;
}

export interface Range {
  from: string;
  to: string;
}

export interface Options {
  demo: boolean;
  signUp: boolean;
  localMailbox: boolean;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: OrganisationRole;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrganisationRole;
  expiresAt: string;
}

export interface InvitationPreview {
  email: string;
  organisationName: string;
  role: OrganisationRole;
  hasAccount: boolean;
}

export interface Device {
  id: string;
  userAgent: string;
  ipAddress: string;
  lastUsedAt: string;
  current: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorEmail: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  ipAddress: string;
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface AdminStats {
  users: number;
  organisations: number;
  campaigns: number;
  activeSessions: number;
  suspendedUsers: number;
  eventBacklog: number;
  filteredLastDay: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerifiedAt: string | null;
  suspendedAt: string | null;
  twoFactorEnabledAt: string | null;
  createdAt: string;
  _count: { memberships: number };
}

export interface AdminOrganisation {
  id: string;
  name: string;
  suspendedAt: string | null;
  createdAt: string;
  _count: { memberships: number; campaigns: number };
}

export interface CapturedEmail {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  link: string;
  attachments: Array<{ filename: string; contentType: string; content: string }>;
  createdAt: string;
}

export type CreativeStatus = 'PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED';

export interface Creative {
  id: string;
  campaignId: string;
  name: string;
  clickUrl: string;
  weight: number;
  status: CreativeStatus;
  durationSeconds: number;
  width: number;
  height: number;
  failureReason: string;
  rejectionReason: string;
  aiReview?: AiReview | null;
  videoUrl: string;
  posterUrl: string;
  createdAt: string;
  results?: {
    impressions: number;
    clicks: number;
    ctr: number;
    completionRate: number;
  };
  comparison?: 'LEADING' | 'BEHIND' | 'TOO_CLOSE' | 'NOT_ENOUGH_DATA';
}

export interface ReviewItem extends Creative {
  campaignTitle: string;
}

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fields?: Record<string, string[]>,
    public readonly code?: string,
  ) {
    super(message);
  }
}

// The access token lives in memory only. The httpOnly cookie restores it after a reload.
let token = '';
let onExpired = (): void => {};
export const setExpiredHandler = (handler: () => void): void => {
  onExpired = handler;
};

const send = (path: string, init: RequestInit): Promise<Response> =>
  fetch(path, {
    ...init,
    headers: {
      // Browsers set the type themselves for file uploads.
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

// Parallel requests share one refresh, so the cookie rotates once.
let refreshing: Promise<boolean> | null = null;

const refreshToken = (): Promise<boolean> => {
  refreshing ??= fetch('/auth/refresh', { method: 'POST' })
    .then(async (response) => {
      if (!response.ok) return false;
      const body = (await response.json()) as { data: { token: string } };
      token = body.data.token;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await send(path, init);

  if (response.status === 401 && token && (await refreshToken())) {
    response = await send(path, init);
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    meta?: unknown;
    message?: string;
    code?: string;
    errors?: Record<string, string[]>;
  };
  if (!response.ok) {
    if (response.status === 401 && token) {
      token = '';
      onExpired();
    }
    throw new ApiError(response.status, body.message ?? 'Request failed.', body.errors, body.code);
  }
  return (body.meta ? { data: body.data, meta: body.meta } : body.data) as T;
}

/** Fetches a file with the sign-in token and saves it under the name the server gives. */
async function download(path: string, init: RequestInit = {}): Promise<void> {
  let response = await send(path, init);
  if (response.status === 401 && token && (await refreshToken())) response = await send(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? 'Download failed.');
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const post = <T = void>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const patch = (path: string, body: unknown): Promise<void> =>
  request(path, { method: 'PATCH', body: JSON.stringify(body) });

const remove = (path: string): Promise<void> => request(path, { method: 'DELETE' });

const withRange = (path: string, range: Range): string =>
  `${path}?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;

const withSearch = (path: string, params: Record<string, string | number>): string =>
  `${path}?${new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  ).toString()}`;

export const api = {
  /** Restores a signed-in session after a reload. */
  async restore(): Promise<User | null> {
    return (await refreshToken()) ? request<User>('/auth/me') : null;
  },
  async login(email: string, password: string): Promise<User | TwoFactorChallenge> {
    const data = await post<{ token: string } | TwoFactorChallenge>('/auth/login', {
      email,
      password,
    });
    if ('twoFactorRequired' in data) return data;
    token = data.token;
    return request<User>('/auth/me');
  },
  async completeTwoFactor(challengeToken: string, code: string): Promise<User> {
    const data = await post<{ token: string }>('/auth/two-factor', { challengeToken, code });
    token = data.token;
    return request<User>('/auth/me');
  },
  async logout(): Promise<void> {
    await post('/auth/logout').catch(() => undefined);
    token = '';
  },
  me: () => request<User>('/auth/me'),
  options: () => request<Options>('/auth/options'),
  register: (input: { email: string; password: string; name: string; organisationName: string }) =>
    post('/auth/register', input),
  verifyEmail: (verificationToken: string) =>
    post('/auth/verify-email', { token: verificationToken }),
  resendVerification: (email: string) => post('/auth/resend-verification', { email }),
  forgotPassword: (email: string) => post('/auth/forgot-password', { email }),
  resetPassword: (resetToken: string, password: string) =>
    post('/auth/reset-password', { token: resetToken, password }),
  switchOrganisation: (organisationId: string) =>
    post('/auth/switch-organisation', { organisationId }),

  analytics: (range: Range) => request<Campaign[]>(withRange('/campaigns/analytics', range)),
  timeseries: (range: Range) =>
    request<Point[]>(withRange('/campaigns/analytics/timeseries', range)),
  campaign: (id: string, range: Range) =>
    request<CampaignDetail>(withRange(`/campaigns/${id}/analytics`, range)),
  summary: (range: Range) => request<Summary>(withRange('/campaigns/analytics/summary', range)),
  compare: (ids: string[], range: Range) =>
    request<Compared[]>(withSearch('/campaigns/compare', { ids: ids.join(','), ...range })),
  campaigns: () => request<Page<Campaign>>(withSearch('/campaigns', { limit: 100 })),
  shows: () => request<Show[]>('/shows'),
  create: (input: CampaignInput) => post<{ id: string }>('/campaigns', input),
  update: (id: string, input: Partial<CampaignInput>) =>
    request<{ id: string }>(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => remove(`/campaigns/${id}`),

  creatives: (campaignId: string) => request<Creative[]>(withSearch('/creatives', { campaignId })),
  uploadCreative: (campaignId: string, name: string, clickUrl: string, file: File) => {
    const body = new FormData();
    body.append('campaignId', campaignId);
    body.append('name', name);
    body.append('clickUrl', clickUrl);
    body.append('file', file);
    return request<Creative>('/creatives', { method: 'POST', body });
  },
  setCreativeWeight: (id: string, weight: number) => patch(`/creatives/${id}`, { weight }),
  forecast: (input: CampaignInput) => post<Forecast>('/campaigns/forecast', input),
  segments: () => request<Segment[]>('/segments'),
  createSegment: (name: string, genres: string[], minViews: number) =>
    post('/segments', { name, genres, minViews }),
  deleteSegment: (id: string) => remove(`/segments/${id}`),
  deleteCreative: (id: string) => remove(`/creatives/${id}`),
  reviewQueue: () => request<ReviewItem[]>('/admin/creatives'),
  reviewCreative: (id: string, decision: 'APPROVE' | 'REJECT', reason: string) =>
    post(
      `/admin/creatives/${id}/review`,
      decision === 'REJECT' ? { decision, reason } : { decision },
    ),

  updateProfile: (name: string) => patch('/account/profile', { name }),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/account/password', { currentPassword, newPassword }),
  devices: () => request<Device[]>('/account/sessions'),
  signOutOthers: () => remove('/account/sessions'),
  signOutDevice: (id: string) => remove(`/account/sessions/${id}`),
  startTwoFactor: () => post<{ secret: string; qrCode: string }>('/account/two-factor/setup'),
  enableTwoFactor: (code: string) =>
    post<{ recoveryCodes: string[] }>('/account/two-factor/enable', { code }),
  disableTwoFactor: (password: string, code: string) =>
    post('/account/two-factor/disable', { password, code }),

  createOrganisation: (name: string) => post('/team/organisations', { name }),
  members: () => request<Member[]>('/team/members'),
  changeRole: (userId: string, role: OrganisationRole) =>
    patch(`/team/members/${userId}`, { role }),
  removeMember: (userId: string) => remove(`/team/members/${userId}`),
  invitations: () => request<Invitation[]>('/team/invitations'),
  invite: (email: string, role: OrganisationRole) => post('/team/invitations', { email, role }),
  cancelInvitation: (id: string) => remove(`/team/invitations/${id}`),
  teamAudit: (page: number) => request<Page<AuditEntry>>(withSearch('/team/audit', { page })),
  previewInvitation: (invitationToken: string) =>
    post<InvitationPreview>('/invitations/preview', { token: invitationToken }),
  acceptInvitation: (invitationToken: string, name?: string, password?: string) =>
    post('/invitations/accept', {
      token: invitationToken,
      ...(name ? { name } : {}),
      ...(password ? { password } : {}),
    }),

  adminStats: () => request<AdminStats>('/admin/stats'),
  adminUsers: (q: string, page: number) =>
    request<Page<AdminUser>>(withSearch('/admin/users', { q, page })),
  adminOrganisations: (q: string, page: number) =>
    request<Page<AdminOrganisation>>(withSearch('/admin/organisations', { q, page })),
  suspendUser: (id: string, suspended: boolean) => patch(`/admin/users/${id}`, { suspended }),
  suspendOrganisation: (id: string, suspended: boolean) =>
    patch(`/admin/organisations/${id}`, { suspended }),
  adminAudit: (page: number) => request<Page<AuditEntry>>(withSearch('/admin/audit', { page })),

  mailbox: () => request<CapturedEmail[]>('/dev/mailbox'),

  runReport: (definition: ReportDefinition) => post<ReportResult>('/reports/run', definition),
  exportReport: (definition: ReportDefinition, format: 'csv' | 'pdf') =>
    download(`/reports/export?format=${format}`, {
      method: 'POST',
      body: JSON.stringify(definition),
    }),
  reports: () => request<SavedReport[]>('/reports'),
  saveReport: (input: SavedReportInput) => post<SavedReport>('/reports', input),
  updateReport: (id: string, input: SavedReportInput) =>
    request<SavedReport>(`/reports/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteReport: (id: string) => remove(`/reports/${id}`),
  exportSavedReport: (id: string, format: 'csv' | 'pdf') =>
    download(`/reports/${id}/export?format=${format}`),
  sendReport: (id: string) => post<{ sentTo: number }>(`/reports/${id}/send`),

  alerts: (status: 'open' | 'all', campaignId?: string) =>
    request<Alert[]>(withSearch('/alerts', { status, ...(campaignId ? { campaignId } : {}) })),
  setAlertEmails: (alertEmails: boolean) => patch('/account/alerts', { alertEmails }),

  diagnosis: (id: string) => request<Diagnosis>(`/campaigns/${id}/diagnosis`),
  aiStatus: () => request<AiStatus>('/ai/status'),
  ask: (
    question: string,
    campaignId: string | null,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => post<AiAnswer>('/ai/ask', { question, campaignId, history }),
  recommendations: (campaignId: string) =>
    request<Recommendation[]>(`/ai/campaigns/${campaignId}/recommendations`),
  recommend: (campaignId: string) =>
    post<Recommendation[]>(`/ai/campaigns/${campaignId}/recommendations`),
  decide: (id: string, decision: 'approve' | 'reject') =>
    post<Recommendation>(`/ai/recommendations/${id}/${decision}`),
  draftCampaign: (brief: string) => post<CampaignDraft>('/ai/draft-campaign', { brief }),
};
