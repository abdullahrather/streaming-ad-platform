import type { ApiError, AuditEntry, Page } from './api';
import { ROLE_NAMES, formatDateTime } from './format';
import { LANGUAGES, language, setLanguage, t, type Language } from './i18n';

export const firstError = (error: ApiError): string =>
  Object.values(error.fields ?? {}).flat()[0] ?? error.message;

export const ErrorNote = ({ message }: { message: string }) =>
  message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;

export const Pager = ({
  meta,
  onPage,
}: {
  meta: Page<unknown>['meta'];
  onPage: (page: number) => void;
}) =>
  meta.totalPages > 1 ? (
    <nav className="pager" aria-label={t('Pages')}>
      <button
        type="button"
        className="button"
        disabled={meta.page <= 1}
        onClick={() => onPage(meta.page - 1)}
      >
        {t('Previous')}
      </button>
      <span className="muted small">
        {t('Page {page} of {totalPages}', { page: meta.page, totalPages: meta.totalPages })}
      </span>
      <button
        type="button"
        className="button"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPage(meta.page + 1)}
      >
        {t('Next')}
      </button>
    </nav>
  ) : null;

const ACTION_LABELS: Record<string, string> = {
  'account.email_verified': t('Confirmed their email'),
  'account.password_changed': t('Changed their password'),
  'account.password_reset': t('Reset their password'),
  'account.registered': t('Created an account'),
  'account.sessions_ended': t('Signed out other devices'),
  'account.two_factor_disabled': t('Turned off two-factor login'),
  'account.two_factor_enabled': t('Turned on two-factor login'),
  'admin.organisation_restored': t('Restored an organisation'),
  'admin.organisation_suspended': t('Suspended an organisation'),
  'admin.user_restored': t('Restored a user'),
  'admin.user_suspended': t('Suspended a user'),
  'auth.login': t('Signed in'),
  'auth.login_failed': t('Failed to sign in'),
  'auth.organisation_switched': t('Switched organisation'),
  'auth.recovery_code_used': t('Used a recovery code'),
  'auth.session_reuse_detected': t('Stolen session blocked'),
  'auth.two_factor_failed': t('Entered a wrong two-factor code'),
  'auth.two_factor_locked': t('Locked after too many wrong codes'),
  'campaign.created': t('Created a campaign'),
  'campaign.deleted': t('Deleted a campaign'),
  'campaign.updated': t('Changed a campaign'),
  'creative.approved': t('Approved an ad'),
  'creative.deleted': t('Deleted an ad'),
  'creative.rejected': t('Rejected an ad'),
  'creative.uploaded': t('Uploaded an ad'),
  'segment.created': t('Created an audience'),
  'invitation.accepted': t('Accepted an invitation'),
  'invitation.revoked': t('Cancelled an invitation'),
  'member.invited': t('Invited a member'),
  'member.removed': t('Removed a member'),
  'member.role_changed': t('Changed a member’s role'),
  'organisation.created': t('Created an organisation'),
};

const describeDetails = (details: Record<string, unknown>): string => {
  const { title, email, role, name } = details;
  const roleName = typeof role === 'string' ? ROLE_NAMES[role] : undefined;
  return [title, name, email, roleName].filter(Boolean).map(String).join(' · ');
};

export const AuditTable = ({ entries }: { entries: AuditEntry[] }) =>
  entries.length === 0 ? (
    <p className="empty">{t('Nothing recorded yet.')}</p>
  ) : (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('When')}</th>
            <th scope="col">{t('Who')}</th>
            <th scope="col">{t('What')}</th>
            <th scope="col">{t('Details')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="nowrap">{formatDateTime(entry.createdAt)}</td>
              <td>{entry.actorEmail || t('System')}</td>
              <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
              <td className="muted">{describeDetails(entry.details)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

/** Switches the dashboard between English and German. */
export const LanguagePicker = () => (
  <label className="language-picker">
    <span className="sr-only">{t('Language')}</span>
    <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
      {Object.entries(LANGUAGES).map(([code, name]) => (
        <option key={code} value={code} lang={code}>
          {name}
        </option>
      ))}
    </select>
  </label>
);
