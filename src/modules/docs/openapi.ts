/**
 * src/modules/docs/openapi.ts
 *
 * The OpenAPI document behind /docs. Request bodies are generated from the same
 * Zod schemas that validate requests, so the docs can't drift from the code.
 */
import { z } from 'zod';
import {
  changePasswordSchema,
  deleteAccountSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  updateProfileSchema,
  alertPreferenceSchema,
} from '@/modules/account/account.routes';
import { reportDefinitionSchema, saveReportSchema } from '@/modules/reports/reports.schema';
import { draftSchema } from '@/modules/ai/ai.routes';
import { aiSettingsSchema, pullSchema } from '@/modules/ai/ai.settings';
import { creditSchema, detailsSchema, planSchema } from '@/modules/billing/billing.service';
import { checkoutSchema } from '@/modules/billing/stripe';
import { askSchema } from '@/modules/ai/ai.service';
import { suspendSchema } from '@/modules/admin/admin.routes';
import {
  reviewSchema,
  updateCreativeSchema,
  uploadCreativeSchema,
} from '@/modules/creatives/creatives.schema';
import { createSegmentSchema } from '@/modules/segments/segments.routes';
import {
  emailSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  switchOrganisationSchema,
  tokenSchema,
  twoFactorChallengeSchema,
} from '@/modules/auth/auth.schema';
import {
  createCampaignSchema,
  forecastSchema,
  updateCampaignSchema,
} from '@/modules/campaigns/campaigns.schema';
import { eventBatchSchema, playerTokenSchema } from '@/modules/delivery/delivery.schema';
import {
  acceptInvitationSchema,
  changeRoleSchema,
  createOrganisationSchema,
  invitationTokenSchema,
  inviteSchema,
} from '@/modules/team/team.schema';

const toSchema = (schema: z.ZodType): unknown => {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema: output }) => {
      if (zodSchema._zod.def.type === 'date') {
        output.type = 'string';
        output.format = 'date-time';
      }
    },
  });
  delete jsonSchema['$schema'];
  return jsonSchema;
};

const jsonBody = (schema: z.ZodType): unknown => ({
  required: true,
  content: { 'application/json': { schema: toSchema(schema) } },
});

const query = (name: string, description: string, required = false): unknown => ({
  name,
  in: 'query',
  required,
  description,
  schema: { type: 'string' },
});

const campaignId = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Campaign ID',
  schema: { type: 'string' },
};

const pathId = (name: string, description: string): unknown => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const paging = [query('page', 'Page number, from 1'), query('limit', 'Items per page')];

const dateRange = [
  query('from', 'Start of the period (ISO 8601). Defaults to 7 days before "to".'),
  query('to', 'End of the period (ISO 8601). Defaults to now.'),
];

const responses = (status: string, description: string, ...errors: string[]): unknown => ({
  [status]: { description },
  ...Object.fromEntries(errors.map((code) => [code, { $ref: `#/components/responses/${code}` }])),
});

const dashboard = (tag: string): { tags: string[]; security: unknown[] } => ({
  tags: [tag],
  security: [{ bearerAuth: [] }],
});

const adServer = { tags: ['Ad server'], security: [{ ingestKey: [] }] };

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Campaign Analytics API',
    version: '1.0.0',
    description:
      'Ad campaigns, teams, ad decisions and event tracking for a streaming service. Sign in ' +
      'with `POST /auth/login`, then press Authorize and paste the token. Access tokens last ' +
      '15 minutes; `POST /auth/refresh` replaces them using the httpOnly cookie.',
    license: { name: 'MIT', url: 'https://opensource.org/license/mit' },
  },
  tags: [
    { name: 'Service', description: 'Status and configuration' },
    { name: 'Auth', description: 'Accounts and signing in' },
    { name: 'Account', description: 'Your password, devices and two-factor login' },
    { name: 'Team', description: 'Your active organisation' },
    { name: 'Admin', description: 'The platform admin console' },
    { name: 'Campaigns', description: 'Managing campaigns' },
    { name: 'Analytics', description: 'Measuring performance' },
    { name: 'Reports', description: 'Custom reports, CSV and PDF export, and scheduled emails' },
    { name: 'Alerts', description: 'Under-delivery, budget burn and sudden drops' },
    {
      name: 'AI assistant',
      description:
        'Optional. A platform admin turns it on from the dashboard, or AI_PROVIDER is set in .env. Reads only what the signed-in user can see; changes need a person to approve them.',
    },
    {
      name: 'Billing',
      description:
        'Prepaid balances. A running campaign holds its unspent budget against the balance; a finished campaign gets one invoice, paid from it.',
    },
    { name: 'Catalogue', description: 'Shows that ads can run against' },
    { name: 'Creatives', description: 'Video ads and their review' },
    { name: 'Audiences', description: 'Segments built from viewing interests' },
    { name: 'Playback', description: 'Public endpoints used by video players' },
    { name: 'Ad server', description: 'Used by the ad server or player, with an API key' },
  ],
  paths: {
    '/live': {
      get: {
        tags: ['Service'],
        summary: 'Check the service is running, without touching the database',
        responses: responses('200', 'Running'),
      },
    },
    '/metrics': {
      get: {
        tags: ['Service'],
        summary: 'Prometheus metrics',
        description:
          'Request timings by route, ad decisions, events, the queue backlog, whether Postgres and Redis answer, scheduled task failures, and the newest backup and restore drill. With METRICS_TOKEN set, send it as a bearer token; without one, this is only served outside production.',
        responses: responses('200', 'Metrics in the Prometheus text format', '401'),
      },
    },
    '/ops/alerts': {
      post: {
        tags: ['Service'],
        summary: 'Alertmanager webhook',
        description:
          'Called by Alertmanager, not by people. Needs ALERT_WEBHOOK_TOKEN as a bearer token. Emails each firing or resolved alert to the platform admins.',
        responses: responses(
          '200',
          'How many alerts and how many admins they went to',
          '401',
          '422',
        ),
      },
    },
    '/health': {
      get: {
        tags: ['Service'],
        summary: 'Check the service and its database',
        responses: {
          200: { description: 'Healthy' },
          503: { description: 'Database unavailable' },
        },
      },
    },
    '/auth/options': {
      get: {
        tags: ['Auth'],
        summary: 'See which sign-in options apply here',
        responses: responses('200', 'Sign-in options'),
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account and its organisation',
        description: 'Responds the same way for a taken email, and sends a confirmation link.',
        requestBody: jsonBody(registerSchema),
        responses: responses('202', 'Check your email', '403', '422'),
      },
    },
    '/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm an email address',
        requestBody: jsonBody(tokenSchema),
        responses: responses('200', 'Confirmed', '400', '422'),
      },
    },
    '/auth/resend-verification': {
      post: {
        tags: ['Auth'],
        summary: 'Send the confirmation link again',
        requestBody: jsonBody(emailSchema),
        responses: responses('202', 'Sent if the account needs it', '422'),
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in and receive a token',
        description:
          'With two-factor login on, this returns a challenge token for `POST /auth/two-factor`.',
        requestBody: jsonBody(loginSchema),
        responses: responses('200', 'Signed in, or a two-factor challenge', '401', '403', '422'),
      },
    },
    '/auth/two-factor': {
      post: {
        tags: ['Auth'],
        summary: 'Finish signing in with an authenticator or recovery code',
        description: 'Five wrong codes lock two-factor sign-in for the account for 15 minutes.',
        requestBody: jsonBody(twoFactorChallengeSchema),
        responses: responses('200', 'Signed in', '401', '403', '422', '429'),
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Replace an expired access token using the refresh cookie',
        responses: responses('200', 'A new access token', '401'),
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'End this session',
        responses: responses('204', 'Signed out'),
      },
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Send a password reset link',
        requestBody: jsonBody(emailSchema),
        responses: responses('202', 'Sent if the account exists', '422'),
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Choose a new password and sign out every device',
        requestBody: jsonBody(resetPasswordSchema),
        responses: responses('200', 'Password changed', '400', '422'),
      },
    },
    '/auth/me': {
      get: {
        ...dashboard('Auth'),
        summary: 'Your profile and organisations',
        responses: responses('200', 'Your profile', '401'),
      },
    },
    '/auth/switch-organisation': {
      post: {
        ...dashboard('Auth'),
        summary: 'Change the active organisation for this session',
        requestBody: jsonBody(switchOrganisationSchema),
        responses: responses('204', 'Switched', '401', '403', '404', '422'),
      },
    },
    '/account/profile': {
      patch: {
        ...dashboard('Account'),
        summary: 'Update your name',
        requestBody: jsonBody(updateProfileSchema),
        responses: responses('204', 'Updated', '401', '403', '422'),
      },
    },
    '/account/password': {
      post: {
        ...dashboard('Account'),
        summary: 'Change your password and sign out other devices',
        requestBody: jsonBody(changePasswordSchema),
        responses: responses('204', 'Changed', '401', '403', '422'),
      },
    },
    '/account/alerts': {
      patch: {
        ...dashboard('Account'),
        summary: 'Turn campaign alert emails on or off for your active organisation',
        requestBody: jsonBody(alertPreferenceSchema),
        responses: responses('204', 'Updated', '401', '403', '409', '422'),
      },
    },
    '/account/sessions': {
      get: {
        ...dashboard('Account'),
        summary: 'List your signed-in devices',
        responses: responses('200', 'Your sessions', '401', '403'),
      },
      delete: {
        ...dashboard('Account'),
        summary: 'Sign out every device except this one',
        responses: responses('204', 'Signed out', '401', '403'),
      },
    },
    '/account/sessions/{id}': {
      delete: {
        ...dashboard('Account'),
        summary: 'Sign out one device',
        parameters: [pathId('id', 'Session ID')],
        responses: responses('204', 'Signed out', '401', '403', '404'),
      },
    },
    '/account/export': {
      get: {
        ...dashboard('Account'),
        summary: 'Download everything held about you',
        description: 'Profile, teams, devices, invitations sent, campaigns created and activity.',
        responses: responses('200', 'Your data as JSON', '401', '403'),
      },
    },
    '/account': {
      delete: {
        ...dashboard('Account'),
        summary: 'Delete your account',
        description:
          'Removes your name and email and signs you out everywhere. Your teams keep their campaigns and invoices. Refused while you are the only owner of a team with other members, or the only member of one with campaigns running.',
        requestBody: jsonBody(deleteAccountSchema),
        responses: responses('204', 'Deleted', '401', '403', '409', '422'),
      },
    },
    '/account/two-factor/setup': {
      post: {
        ...dashboard('Account'),
        summary: 'Start two-factor setup and get a QR code',
        responses: responses('200', 'A secret and QR code', '401', '403', '409'),
      },
    },
    '/account/two-factor/enable': {
      post: {
        ...dashboard('Account'),
        summary: 'Turn on two-factor login with a first code',
        description: 'Returns recovery codes. They are shown only once.',
        requestBody: jsonBody(enableTwoFactorSchema),
        responses: responses('200', 'Recovery codes', '401', '403', '409', '422'),
      },
    },
    '/account/two-factor/disable': {
      post: {
        ...dashboard('Account'),
        summary: 'Turn off two-factor login',
        requestBody: jsonBody(disableTwoFactorSchema),
        responses: responses('204', 'Turned off', '401', '403', '409', '422'),
      },
    },
    '/team/organisations': {
      post: {
        ...dashboard('Team'),
        summary: 'Create another organisation and switch to it',
        requestBody: jsonBody(createOrganisationSchema),
        responses: responses('201', 'Created', '401', '403', '422'),
      },
    },
    '/team/members': {
      get: {
        ...dashboard('Team'),
        summary: 'List members',
        responses: responses('200', 'Members', '401', '403'),
      },
    },
    '/team/members/{userId}': {
      patch: {
        ...dashboard('Team'),
        summary: "Change a member's role (owners)",
        parameters: [pathId('userId', 'User ID')],
        requestBody: jsonBody(changeRoleSchema),
        responses: responses('204', 'Changed', '401', '403', '404', '409', '422'),
      },
      delete: {
        ...dashboard('Team'),
        summary: 'Remove a member (owners), or leave yourself',
        parameters: [pathId('userId', 'User ID')],
        responses: responses('204', 'Removed', '401', '403', '404', '409'),
      },
    },
    '/team/invitations': {
      get: {
        ...dashboard('Team'),
        summary: 'List open invitations (owners and managers)',
        responses: responses('200', 'Invitations', '401', '403'),
      },
      post: {
        ...dashboard('Team'),
        summary: 'Invite someone by email (owners)',
        requestBody: jsonBody(inviteSchema),
        responses: responses('201', 'Invited', '401', '403', '409', '422'),
      },
    },
    '/team/invitations/{id}': {
      delete: {
        ...dashboard('Team'),
        summary: 'Cancel an invitation (owners)',
        parameters: [pathId('id', 'Invitation ID')],
        responses: responses('204', 'Cancelled', '401', '403', '404'),
      },
    },
    '/team/audit': {
      get: {
        ...dashboard('Team'),
        summary: 'Activity history (owners and managers)',
        parameters: [...paging, query('action', 'Only actions starting with this')],
        responses: responses('200', 'Newest first', '401', '403', '422'),
      },
    },
    '/invitations/preview': {
      post: {
        tags: ['Team'],
        summary: 'See what an invitation link is for',
        requestBody: jsonBody(invitationTokenSchema),
        responses: responses('200', 'Invitation details', '400', '422'),
      },
    },
    '/invitations/accept': {
      post: {
        tags: ['Team'],
        summary: 'Accept an invitation',
        description:
          'New people send a name and password. People with an account send their token.',
        requestBody: jsonBody(acceptInvitationSchema),
        responses: responses('200', 'Joined', '400', '401', '422'),
      },
    },
    '/admin/stats': {
      get: {
        ...dashboard('Admin'),
        summary: 'Platform totals',
        responses: responses('200', 'Totals', '401', '403'),
      },
    },
    '/admin/users': {
      get: {
        ...dashboard('Admin'),
        summary: 'Search users',
        parameters: [query('q', 'Email or name'), ...paging],
        responses: responses('200', 'Users', '401', '403', '422'),
      },
    },
    '/admin/users/{id}': {
      patch: {
        ...dashboard('Admin'),
        summary: 'Suspend or restore a user',
        parameters: [pathId('id', 'User ID')],
        requestBody: jsonBody(suspendSchema),
        responses: responses('204', 'Updated', '401', '403', '404', '409', '422'),
      },
    },
    '/admin/organisations': {
      get: {
        ...dashboard('Admin'),
        summary: 'Search organisations',
        parameters: [query('q', 'Name'), ...paging],
        responses: responses('200', 'Organisations', '401', '403', '422'),
      },
    },
    '/admin/organisations/{id}': {
      patch: {
        ...dashboard('Admin'),
        summary: 'Suspend or restore an organisation',
        parameters: [pathId('id', 'Organisation ID')],
        requestBody: jsonBody(suspendSchema),
        responses: responses('204', 'Updated', '401', '403', '404', '422'),
      },
    },
    '/admin/audit': {
      get: {
        ...dashboard('Admin'),
        summary: 'Activity history across the platform',
        parameters: [...paging, query('action', 'Only actions starting with this')],
        responses: responses('200', 'Newest first', '401', '403', '422'),
      },
    },
    '/campaigns': {
      get: {
        ...dashboard('Campaigns'),
        summary: 'List campaigns',
        parameters: [
          query('status', 'ACTIVE, PAUSED or COMPLETED'),
          query('page', 'Page number, from 1'),
          query('limit', 'Items per page, up to 100'),
        ],
        responses: responses('200', 'A page of campaigns', '401', '422'),
      },
      post: {
        ...dashboard('Campaigns'),
        summary: 'Create a campaign',
        requestBody: jsonBody(createCampaignSchema),
        responses: responses('201', 'Created', '401', '402', '403', '422'),
      },
    },
    '/campaigns/analytics': {
      get: {
        ...dashboard('Analytics'),
        summary: 'Totals, pacing and spend per campaign',
        parameters: dateRange,
        responses: responses('200', 'One row per campaign', '401', '422'),
      },
    },
    '/campaigns/analytics/timeseries': {
      get: {
        ...dashboard('Analytics'),
        summary: 'Performance over time across campaigns',
        description: 'Hourly for periods up to three days, otherwise daily.',
        parameters: dateRange,
        responses: responses('200', 'Points in time order', '401', '422'),
      },
    },
    '/campaigns/analytics/summary': {
      get: {
        ...dashboard('Analytics'),
        summary: 'Totals and spend for a period and the period before it',
        description: 'The previous period has the same length and ends where this one starts.',
        parameters: dateRange,
        responses: responses('200', 'Current and previous totals', '401', '422'),
      },
    },
    '/campaigns/compare': {
      get: {
        ...dashboard('Analytics'),
        summary: 'Compare two to four campaigns side by side',
        parameters: [query('ids', 'Comma-separated campaign IDs, two to four', true), ...dateRange],
        responses: responses('200', 'Totals, reach and trend per campaign', '401', '404', '422'),
      },
    },
    '/campaigns/{id}/diagnosis': {
      get: {
        ...dashboard('Analytics'),
        summary: 'Why a campaign is behind, and whether it will reach its goal',
        description:
          "Computed from the campaign's data with no AI: the binding limit (matching traffic, budget, daily limits, frequency cap), blockers such as being paused or having no approved ad, and the outlook at the recent pace.",
        parameters: [campaignId],
        responses: responses('200', 'The diagnosis', '401', '404'),
      },
    },
    '/campaigns/{id}': {
      get: {
        ...dashboard('Campaigns'),
        summary: 'Read a campaign',
        parameters: [campaignId],
        responses: responses('200', 'The campaign', '401', '404'),
      },
      patch: {
        ...dashboard('Campaigns'),
        summary: 'Change a campaign, including pausing and resuming',
        parameters: [campaignId],
        requestBody: jsonBody(updateCampaignSchema),
        responses: responses('200', 'Updated', '401', '402', '403', '404', '409', '422'),
      },
      delete: {
        ...dashboard('Campaigns'),
        summary: 'Delete a campaign and its metrics',
        parameters: [campaignId],
        responses: responses('204', 'Deleted', '401', '403', '404'),
      },
    },
    '/campaigns/{id}/analytics': {
      get: {
        ...dashboard('Analytics'),
        summary: 'One campaign with its trend and breakdowns',
        parameters: [campaignId, ...dateRange],
        responses: responses('200', 'Campaign analytics', '401', '404', '422'),
      },
    },
    '/creatives': {
      get: {
        ...dashboard('Creatives'),
        summary: "List a campaign's video ads",
        parameters: [query('campaignId', 'Campaign ID', true)],
        responses: responses('200', 'Ads', '401', '404', '422'),
      },
      post: {
        ...dashboard('Creatives'),
        summary: 'Upload a video ad',
        description:
          'Send multipart form data with a `file` field. Ads last 5 to 120 seconds, are at ' +
          'least 240 pixels tall, are converted in the background, and need admin approval.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file', 'campaignId', 'name', 'clickUrl'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  ...(toSchema(uploadCreativeSchema) as { properties: object }).properties,
                },
              },
            },
          },
        },
        responses: responses('201', 'Uploaded', '401', '403', '404', '413', '422'),
      },
    },
    '/campaigns/forecast': {
      post: {
        ...dashboard('Analytics'),
        summary: 'Predict delivery and reach before launching',
        requestBody: jsonBody(forecastSchema),
        responses: responses('200', 'The forecast', '401', '422'),
      },
    },
    '/segments': {
      get: {
        ...dashboard('Audiences'),
        summary: "List your organisation's audience segments",
        responses: responses('200', 'Segments', '401'),
      },
      post: {
        ...dashboard('Audiences'),
        summary: 'Create an audience segment from viewing interests',
        description: 'Segments only ever match viewers who consented.',
        requestBody: jsonBody(createSegmentSchema),
        responses: responses('201', 'Created', '401', '403', '409', '422'),
      },
    },
    '/segments/{id}': {
      delete: {
        ...dashboard('Audiences'),
        summary: 'Delete an audience segment',
        parameters: [pathId('id', 'Segment ID')],
        responses: responses('204', 'Deleted', '401', '403', '404', '409'),
      },
    },
    '/reports/run': {
      post: {
        ...dashboard('Reports'),
        summary: 'Run a report without saving it',
        description:
          'Covers the last rangeDays up to now. Reach and average frequency need groupBy CAMPAIGN.',
        requestBody: jsonBody(reportDefinitionSchema),
        responses: responses('200', 'Rows and totals', '401', '422'),
      },
    },
    '/reports/export': {
      post: {
        ...dashboard('Reports'),
        summary: 'Download a report as CSV or PDF',
        parameters: [query('format', 'csv or pdf')],
        requestBody: jsonBody(reportDefinitionSchema),
        responses: responses('200', 'The file', '401', '422'),
      },
    },
    '/reports': {
      get: {
        ...dashboard('Reports'),
        summary: "Your organisation's saved reports",
        responses: responses('200', 'Saved reports', '401'),
      },
      post: {
        ...dashboard('Reports'),
        summary: 'Save a report, optionally emailed daily or weekly',
        description: 'Owners and managers only. Recipients must be members of the organisation.',
        requestBody: jsonBody(saveReportSchema),
        responses: responses('201', 'Saved', '401', '403', '409', '422'),
      },
    },
    '/reports/{id}': {
      get: {
        ...dashboard('Reports'),
        summary: 'Read a saved report',
        parameters: [pathId('id', 'Report ID')],
        responses: responses('200', 'The report', '401', '404'),
      },
      put: {
        ...dashboard('Reports'),
        summary: 'Replace a saved report',
        parameters: [pathId('id', 'Report ID')],
        requestBody: jsonBody(saveReportSchema),
        responses: responses('200', 'Updated', '401', '403', '404', '422'),
      },
      delete: {
        ...dashboard('Reports'),
        summary: 'Delete a saved report',
        parameters: [pathId('id', 'Report ID')],
        responses: responses('204', 'Deleted', '401', '403', '404'),
      },
    },
    '/reports/{id}/export': {
      get: {
        ...dashboard('Reports'),
        summary: 'Run a saved report and download it as CSV or PDF',
        parameters: [pathId('id', 'Report ID'), query('format', 'csv or pdf')],
        responses: responses('200', 'The file', '401', '404', '422'),
      },
    },
    '/reports/{id}/send': {
      post: {
        ...dashboard('Reports'),
        summary: 'Email a saved report to its recipients now',
        parameters: [pathId('id', 'Report ID')],
        responses: responses('200', 'How many people it was sent to', '401', '403', '404'),
      },
    },
    '/alerts': {
      get: {
        ...dashboard('Alerts'),
        summary: 'Campaign alerts, newest first',
        description: 'Alerts open and resolve on their own as campaigns are checked.',
        parameters: [query('status', 'open or all'), query('campaignId', 'Only this campaign')],
        responses: responses('200', 'Alerts', '401', '422'),
      },
    },
    '/ai/status': {
      get: {
        ...dashboard('AI assistant'),
        summary: 'Whether the AI assistant is on, and which provider and model it uses',
        responses: responses('200', 'Status, with the reason when it is off', '401'),
      },
    },
    '/ai/ask': {
      post: {
        ...dashboard('AI assistant'),
        summary: 'Ask a question about your campaigns in plain language',
        description:
          'Answers come from read-only tools scoped to what you can see. Rate limited per person.',
        requestBody: jsonBody(askSchema),
        responses: responses(
          '200',
          'The answer and the tools it used',
          '401',
          '422',
          '429',
          '502',
          '503',
        ),
      },
    },
    '/ai/campaigns/{id}/recommendations': {
      get: {
        ...dashboard('AI assistant'),
        summary: "A campaign's suggested changes and their status",
        parameters: [campaignId],
        responses: responses('200', 'Recommendations, newest first', '401', '404'),
      },
      post: {
        ...dashboard('AI assistant'),
        summary: 'Ask the assistant to suggest changes',
        description:
          'Owners and managers. Suggestions are stored as pending and change nothing until approved.',
        parameters: [campaignId],
        responses: responses(
          '201',
          'New pending recommendations',
          '401',
          '403',
          '404',
          '429',
          '502',
          '503',
        ),
      },
    },
    '/ai/recommendations/{id}/approve': {
      post: {
        ...dashboard('AI assistant'),
        summary: 'Apply a suggested change',
        description:
          'Owners and managers. Refused if the campaign changed since the suggestion was made.',
        parameters: [pathId('id', 'Recommendation ID')],
        responses: responses('200', 'Applied', '401', '403', '404', '409', '422'),
      },
    },
    '/ai/recommendations/{id}/reject': {
      post: {
        ...dashboard('AI assistant'),
        summary: 'Turn down a suggested change',
        parameters: [pathId('id', 'Recommendation ID')],
        responses: responses('200', 'Rejected', '401', '403', '404', '409'),
      },
    },
    '/ai/draft-campaign': {
      post: {
        ...dashboard('AI assistant'),
        summary: 'Draft a campaign from a written brief',
        description: 'Owners and managers. Returns campaign fields to review; nothing is saved.',
        requestBody: jsonBody(draftSchema),
        responses: responses(
          '200',
          'The draft and its assumptions',
          '401',
          '403',
          '422',
          '429',
          '502',
          '503',
        ),
      },
    },
    '/billing': {
      get: {
        ...dashboard('Billing'),
        summary: 'Your organisation’s balance, what running campaigns hold, history and invoices',
        description: 'Owners and managers.',
        responses: responses('200', 'Balance, holds, entries and invoices', '401', '403'),
      },
    },
    '/billing/invoices/{id}/pdf': {
      get: {
        ...dashboard('Billing'),
        summary: 'Download an invoice as a PDF',
        description: 'Owners and managers of the invoice’s organisation, and platform admins.',
        parameters: [pathId('id', 'Invoice ID')],
        responses: responses('200', 'The PDF', '401', '404'),
      },
    },
    '/billing/organisations': {
      get: {
        ...dashboard('Billing'),
        summary: 'Every organisation’s balance',
        description: 'Platform admins.',
        responses: responses(
          '200',
          'Organisations with balance, holds and invoice count',
          '401',
          '403',
        ),
      },
    },
    '/billing/organisations/{id}/credits': {
      post: {
        ...dashboard('Billing'),
        summary: 'Add credit to an organisation’s balance',
        description:
          'Platform admins, such as when a bank transfer arrives. Recorded in the activity log.',
        parameters: [pathId('id', 'Organisation ID')],
        requestBody: jsonBody(creditSchema),
        responses: responses('201', 'The new ledger entry', '401', '403', '404', '422'),
      },
    },
    '/billing/details': {
      put: {
        ...dashboard('Billing'),
        summary: 'Change the billing details printed on invoices',
        description:
          'Owners. Name, address, country, VAT ID and the currency to pay and be invoiced in. They decide the VAT: German customers pay 19%, EU businesses with a VAT ID confirmed by VIES get the reverse charge, and customers outside the EU pay no German VAT.',
        requestBody: jsonBody(detailsSchema),
        responses: responses(
          '200',
          'The details, the VAT that applies, and the VAT ID check',
          '401',
          '403',
          '422',
          '503',
        ),
      },
    },
    '/billing/checkout': {
      post: {
        ...dashboard('Billing'),
        summary: 'Start a card payment to add credit',
        description:
          'Owners. Needs STRIPE_SECRET_KEY. Returns the Stripe Checkout page to send the payer to. The amount is in the organisation’s currency.',
        requestBody: jsonBody(checkoutSchema),
        responses: responses('201', 'The payment page', '401', '403', '422', '503'),
      },
    },
    '/billing/checkout/{id}/confirm': {
      post: {
        ...dashboard('Billing'),
        summary: 'Check a card payment when the payer comes back',
        description:
          'Owners. Credits the balance once Stripe says it is paid, converted to euros at the day’s rate. Safe to call more than once, and works without a webhook.',
        parameters: [pathId('id', 'Stripe Checkout Session ID')],
        responses: responses(
          '200',
          'Whether it is paid, and the ledger entry',
          '401',
          '403',
          '404',
          '503',
        ),
      },
    },
    '/billing/stripe/webhook': {
      post: {
        tags: ['Billing'],
        summary: 'Stripe webhook',
        description:
          'Called by Stripe, not by people. Needs STRIPE_WEBHOOK_SECRET. The Stripe-Signature header is checked against the raw body before anything is read. A paid Checkout Session is credited once, however often it arrives.',
        responses: responses('200', 'Received', '400', '503'),
      },
    },
    '/billing/organisations/{id}': {
      patch: {
        ...dashboard('Billing'),
        summary: 'Change an organisation’s plan',
        description:
          'Platform admins. Starter allows 2 running campaigns, 3 members and 1 scheduled report; Growth 10 of each; Enterprise has no limits. Recorded in the activity log.',
        parameters: [pathId('id', 'Organisation ID')],
        requestBody: jsonBody(planSchema),
        responses: responses('200', 'The new plan', '401', '403', '404', '422'),
      },
    },
    '/billing/revenue': {
      get: {
        ...dashboard('Billing'),
        summary: 'What the platform earned as the publisher',
        description:
          'Platform admins. Delivered revenue in a period by show, advertiser and ad slot, with what was invoiced, credit paid in, and revenue not yet invoiced.',
        parameters: [
          query('from', 'Start, ISO date. Defaults to 7 days ago'),
          query('to', 'End, ISO date. Defaults to now'),
        ],
        responses: responses('200', 'Revenue and its breakdowns', '401', '403', '422'),
      },
    },
    '/ai/settings': {
      get: {
        ...dashboard('AI assistant'),
        summary: 'The assistant’s saved settings',
        description:
          'Platform admins. The key is never returned, only its last four characters. `lockedByEnv` is true when AI_PROVIDER in .env decides instead.',
        responses: responses('200', 'The settings and current status', '401', '403'),
      },
      put: {
        ...dashboard('AI assistant'),
        summary: 'Turn the assistant on or off, and choose its provider',
        description:
          'Platform admins. The key is stored encrypted. Leave `apiKey` empty to keep the saved key for the same provider. Refused when AI_PROVIDER is set in .env, and in the public demo.',
        requestBody: jsonBody(aiSettingsSchema),
        responses: responses('200', 'Saved', '401', '403', '409', '422'),
      },
    },
    '/ai/settings/test': {
      post: {
        ...dashboard('AI assistant'),
        summary: 'Check that settings work, before or after saving them',
        description:
          'Platform admins. Sends one tiny request and reports how long it took, or why it failed.',
        requestBody: jsonBody(aiSettingsSchema),
        responses: responses(
          '200',
          'Whether it worked, with a message',
          '401',
          '403',
          '422',
          '429',
        ),
      },
    },
    '/ai/local/status': {
      get: {
        ...dashboard('AI assistant'),
        summary: 'Whether Ollama is running, and which models it has',
        parameters: [query('baseUrl', 'Ollama’s address. Defaults to http://localhost:11434/v1')],
        responses: responses('200', 'Ollama’s status and models', '401', '403'),
      },
    },
    '/ai/local/pull': {
      get: {
        ...dashboard('AI assistant'),
        summary: 'Progress of a model download',
        parameters: [query('model', 'The model being downloaded', true)],
        responses: responses(
          '200',
          'Bytes done of total, or null if none was started',
          '401',
          '403',
        ),
      },
      post: {
        ...dashboard('AI assistant'),
        summary: 'Download a model through Ollama',
        description:
          'Platform admins. Starts the download and returns at once; read progress with GET.',
        requestBody: jsonBody(pullSchema),
        responses: responses('202', 'Started', '401', '403', '409', '422'),
      },
    },
    '/player/profile': {
      delete: {
        tags: ['Playback'],
        summary: "Delete a viewer's interest profile",
        description: 'For a viewer withdrawing consent.',
        parameters: [query('token', 'Player token', true)],
        responses: responses('204', 'Deleted', '401'),
      },
    },
    '/player/data': {
      get: {
        tags: ['Playback'],
        summary: 'Download everything held about a viewer',
        description: 'The interest profile and the ads seen per campaign each day, as JSON.',
        parameters: [query('token', 'Player token', true)],
        responses: responses('200', "The viewer's data", '401'),
      },
      delete: {
        tags: ['Playback'],
        summary: 'Delete everything held about a viewer',
        description:
          'Reach and audience counts stay: they are anonymous estimates that cannot be traced to anyone.',
        parameters: [query('token', 'Player token', true)],
        responses: responses('204', 'Deleted', '401'),
      },
    },
    '/creatives/{id}': {
      patch: {
        ...dashboard('Creatives'),
        summary: "Set an ad's share of its campaign",
        parameters: [pathId('id', 'Ad ID')],
        requestBody: jsonBody(updateCreativeSchema),
        responses: responses('204', 'Updated', '401', '403', '404', '422'),
      },
      delete: {
        ...dashboard('Creatives'),
        summary: 'Delete a video ad',
        parameters: [pathId('id', 'Ad ID')],
        responses: responses('204', 'Deleted', '401', '403', '404'),
      },
    },
    '/admin/creatives': {
      get: {
        ...dashboard('Admin'),
        summary: 'List ads waiting for review',
        parameters: [query('status', 'Defaults to PENDING_REVIEW')],
        responses: responses('200', 'Ads', '401', '403', '422'),
      },
    },
    '/admin/creatives/{id}/review': {
      post: {
        ...dashboard('Admin'),
        summary: 'Approve or reject an ad',
        parameters: [pathId('id', 'Ad ID')],
        requestBody: jsonBody(reviewSchema),
        responses: responses('204', 'Decided', '401', '403', '404', '409', '422'),
      },
    },
    '/media/creatives/{id}/video': {
      get: {
        tags: ['Playback'],
        summary: 'Stream an ad video',
        description: 'Approved ads are public. Others need the preview token from the API.',
        parameters: [pathId('id', 'Ad ID'), query('t', 'Preview token')],
        responses: responses('200', 'Video', '404'),
      },
    },
    '/media/creatives/{id}/poster': {
      get: {
        tags: ['Playback'],
        summary: 'Get an ad preview image',
        parameters: [pathId('id', 'Ad ID'), query('t', 'Preview token')],
        responses: responses('200', 'Image', '404'),
      },
    },
    '/media/shows/{id}/{file}': {
      get: {
        tags: ['Playback'],
        summary: 'Stream a demo episode or its poster',
        parameters: [pathId('id', 'Show ID'), pathId('file', 'video or poster')],
        responses: responses('200', 'File', '404'),
      },
    },
    '/player-tokens': {
      post: {
        ...adServer,
        summary: 'Exchange the ad server key for a 15-minute player token',
        description: "Call this from a publisher's server, never from a player.",
        requestBody: jsonBody(playerTokenSchema),
        responses: responses('201', 'A player token', '401', '422'),
      },
    },
    '/player/session': {
      post: {
        tags: ['Playback'],
        summary: 'Get a player token for the demo site',
        description: "Stands in for a publisher's server. Closed in production.",
        responses: responses('201', 'A player token', '404'),
      },
    },
    '/player/catalogue': {
      get: {
        tags: ['Playback'],
        summary: 'List shows the demo site can play',
        responses: responses('200', 'Shows'),
      },
    },
    '/vast': {
      get: {
        tags: ['Playback'],
        summary: 'Get an ad for an ad break as VAST 4.2 XML',
        description:
          'An empty VAST document means nothing can run in this break, or the request was ' +
          'filtered as invalid traffic.',
        parameters: [
          query('token', 'Player token', true),
          query('showId', 'Show ID', true),
          query('slot', 'PRE_ROLL, MID_ROLL or POST_ROLL', true),
          query('country', 'Two-letter country code', true),
          query('device', 'CTV, MOBILE, WEB or TABLET', true),
        ],
        responses: responses('200', 'VAST XML', '401', '422'),
      },
    },
    '/track/{event}': {
      get: {
        tags: ['Playback'],
        summary: 'Report ad progress, using a link from the VAST',
        parameters: [
          pathId('event', 'impression, start, firstQuartile, midpoint, thirdQuartile or complete'),
          query('t', 'Signed token', true),
        ],
        responses: responses('204', 'Recorded', '400', '404'),
      },
    },
    '/click': {
      get: {
        tags: ['Playback'],
        summary: "Record a click and redirect to the advertiser's page",
        parameters: [query('t', 'Signed token', true)],
        responses: { 302: { description: 'Redirect' }, 400: { description: 'Invalid link' } },
      },
    },
    '/shows': {
      get: {
        ...dashboard('Catalogue'),
        summary: 'List shows',
        responses: responses('200', 'The catalogue', '401'),
      },
    },
    '/ad-decision': {
      get: {
        ...adServer,
        summary: 'Choose the ad for an ad break',
        description:
          'Returns the eligible campaign furthest behind schedule, or null when nothing can run.',
        parameters: [
          query('showId', 'Show ID', true),
          query('slot', 'PRE_ROLL, MID_ROLL or POST_ROLL', true),
          query('country', 'Two-letter country code', true),
          query('device', 'CTV, MOBILE, WEB or TABLET', true),
        ],
        responses: responses('200', 'The chosen campaign, or null', '401', '422'),
      },
    },
    '/events': {
      post: {
        ...adServer,
        summary: 'Queue a batch of up to 1,000 ad events',
        description:
          'Each event needs a unique eventId and an occurredAt within the last hour. Sending a ' +
          'batch twice is safe: repeats are dropped. Totals update shortly after.',
        requestBody: jsonBody(eventBatchSchema),
        responses: responses('202', 'Accepted', '401', '422'),
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      ingestKey: { type: 'apiKey', in: 'header', name: 'x-ingest-key' },
    },
    responses: {
      400: { description: 'The link is invalid or has expired' },
      401: { description: 'Sign-in or API key required' },
      402: { description: 'Not enough prepaid balance for the campaign’s budget' },
      403: { description: 'Your role or account does not allow this' },
      404: { description: 'Not found, or belongs to another advertiser' },
      409: { description: 'Not allowed in the current state' },
      413: { description: 'The file is too large' },
      422: { description: 'The request failed validation' },
      429: { description: 'Too many attempts' },
      502: { description: 'The AI model could not be reached' },
      503: { description: 'The AI assistant is not turned on' },
    },
  },
};
