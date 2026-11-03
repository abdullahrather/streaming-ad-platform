import type { ApiError, AuditEntry, Page } from './api';
import { ROLE_NAMES, formatDateTime } from './format';

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
    <nav className="pager" aria-label="Pages">
      <button
        type="button"
        className="button"
        disabled={meta.page <= 1}
        onClick={() => onPage(meta.page - 1)}
      >
        Previous
      </button>
      <span className="muted small">
        Page {meta.page} of {meta.totalPages}
      </span>
      <button
        type="button"
        className="button"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPage(meta.page + 1)}
      >
        Next
      </button>
    </nav>
  ) : null;

const ACTION_LABELS: Record<string, string> = {
  'account.email_verified': 'Confirmed their email',
  'account.password_changed': 'Changed their password',
  'account.password_reset': 'Reset their password',
  'account.registered': 'Created an account',
  'account.sessions_ended': 'Signed out other devices',
  'account.two_factor_disabled': 'Turned off two-factor login',
  'account.two_factor_enabled': 'Turned on two-factor login',
  'admin.organisation_restored': 'Restored an organisation',
  'admin.organisation_suspended': 'Suspended an organisation',
  'admin.user_restored': 'Restored a user',
  'admin.user_suspended': 'Suspended a user',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed to sign in',
  'auth.organisation_switched': 'Switched organisation',
  'auth.recovery_code_used': 'Used a recovery code',
  'auth.session_reuse_detected': 'Stolen session blocked',
  'auth.two_factor_failed': 'Entered a wrong two-factor code',
  'auth.two_factor_locked': 'Locked after too many wrong codes',
  'campaign.created': 'Created a campaign',
  'campaign.deleted': 'Deleted a campaign',
  'campaign.updated': 'Changed a campaign',
  'creative.approved': 'Approved an ad',
  'creative.deleted': 'Deleted an ad',
  'creative.rejected': 'Rejected an ad',
  'creative.uploaded': 'Uploaded an ad',
  'segment.created': 'Created an audience',
  'invitation.accepted': 'Accepted an invitation',
  'invitation.revoked': 'Cancelled an invitation',
  'member.invited': 'Invited a member',
  'member.removed': 'Removed a member',
  'member.role_changed': 'Changed a member’s role',
  'organisation.created': 'Created an organisation',
};

const describeDetails = (details: Record<string, unknown>): string => {
  const { title, email, role, name } = details;
  const roleName = typeof role === 'string' ? ROLE_NAMES[role] : undefined;
  return [title, name, email, roleName].filter(Boolean).map(String).join(' · ');
};

export const AuditTable = ({ entries }: { entries: AuditEntry[] }) =>
  entries.length === 0 ? (
    <p className="empty">Nothing recorded yet.</p>
  ) : (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="nowrap">{formatDateTime(entry.createdAt)}</td>
              <td>{entry.actorEmail || 'System'}</td>
              <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
              <td className="muted">{describeDetails(entry.details)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
