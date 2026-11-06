import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AdminOrganisation,
  type AdminStats,
  type AdminUser,
  type AuditEntry,
  type CapturedEmail,
  type Page,
  type User,
} from './api';
import { formatDate, formatDateTime, formatNumber } from './format';
import { AuditTable, ErrorNote, Pager, firstError } from './ui';
import { t } from './i18n';

const Suspended = ({ at }: { at: string | null }) => (
  <span className={`badge ${at ? 'badge-serious' : 'badge-good'}`}>
    {at ? t('Suspended') : t('Active')}
  </span>
);

const Stats = ({ stats }: { stats: AdminStats }) => {
  const items = [
    [t('Users'), stats.users],
    [t('Organisations'), stats.organisations],
    [t('Campaigns'), stats.campaigns],
    [t('Active sessions'), stats.activeSessions],
    [t('Suspended users'), stats.suspendedUsers],
    [t('Events waiting to save'), stats.eventBacklog],
    [t('Invalid traffic, last 24 hours'), stats.filteredLastDay],
  ] as const;

  return (
    <dl className="kpis">
      {items.map(([label, value]) => (
        <div key={label} className="card kpi">
          <dt>{label}</dt>
          <dd>{formatNumber(value)}</dd>
        </div>
      ))}
    </dl>
  );
};

const Search = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => (
  <label className="search">
    <span className="sr-only">{label}</span>
    <input
      type="search"
      placeholder={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
);

const UsersCard = ({ self, onChanged }: { self: User; onChanged: () => void }) => {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AdminUser> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .adminUsers(query, page)
      .then(setResult)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [query, page]);

  useEffect(load, [load]);

  const toggle = (user: AdminUser) => {
    setError('');
    api
      .suspendUser(user.id, !user.suspendedAt)
      .then(() => {
        load();
        onChanged();
      })
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  return (
    <section className="card">
      <header className="card-header">
        <h2>{t('Users')}</h2>
        <Search
          label={t('Search users')}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
        />
      </header>
      <ErrorNote message={error} />
      {result && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('Person')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">{t('Email')}</th>
                  <th scope="col">{t('Two-factor')}</th>
                  <th scope="col" className="num">
                    {t('Organisations')}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.name || user.email}
                      <div className="muted small">{user.email}</div>
                    </td>
                    <td>
                      <Suspended at={user.suspendedAt} />
                    </td>
                    <td>{user.emailVerifiedAt ? t('Confirmed') : t('Unconfirmed')}</td>
                    <td>{user.twoFactorEnabledAt ? t('On') : t('Off')}</td>
                    <td className="num">{user._count.memberships}</td>
                    <td className="actions-cell">
                      {user.id !== self.id && (
                        <button
                          type="button"
                          className={user.suspendedAt ? 'button' : 'button danger'}
                          aria-label={`${user.suspendedAt ? 'Restore' : 'Suspend'} ${user.email}`}
                          onClick={() => toggle(user)}
                        >
                          {user.suspendedAt ? t('Restore') : t('Suspend')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager meta={result.meta} onPage={setPage} />
        </>
      )}
    </section>
  );
};

const OrganisationsCard = ({ onChanged }: { onChanged: () => void }) => {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AdminOrganisation> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .adminOrganisations(query, page)
      .then(setResult)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [query, page]);

  useEffect(load, [load]);

  const toggle = (organisation: AdminOrganisation) => {
    setError('');
    api
      .suspendOrganisation(organisation.id, !organisation.suspendedAt)
      .then(() => {
        load();
        onChanged();
      })
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  return (
    <section className="card">
      <header className="card-header">
        <h2>{t('Organisations')}</h2>
        <Search
          label={t('Search organisations')}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
        />
      </header>
      <ErrorNote message={error} />
      {result && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('Name')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">{t('Created')}</th>
                  <th scope="col" className="num">
                    {t('Members')}
                  </th>
                  <th scope="col" className="num">
                    {t('Campaigns')}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((organisation) => (
                  <tr key={organisation.id}>
                    <td>{organisation.name}</td>
                    <td>
                      <Suspended at={organisation.suspendedAt} />
                    </td>
                    <td className="nowrap">{formatDate(organisation.createdAt)}</td>
                    <td className="num">{organisation._count.memberships}</td>
                    <td className="num">{organisation._count.campaigns}</td>
                    <td className="actions-cell">
                      <button
                        type="button"
                        className={organisation.suspendedAt ? 'button' : 'button danger'}
                        aria-label={`${organisation.suspendedAt ? 'Restore' : 'Suspend'} ${organisation.name}`}
                        onClick={() => toggle(organisation)}
                      >
                        {organisation.suspendedAt ? t('Restore') : t('Suspend')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager meta={result.meta} onPage={setPage} />
        </>
      )}
    </section>
  );
};

export const AdminPage = ({ user }: { user: User }) => {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [audit, setAudit] = useState<Page<AuditEntry> | null>(null);
  const [error, setError] = useState('');

  const loadStats = useCallback(() => {
    api
      .adminStats()
      .then(setStats)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, []);

  const loadAudit = useCallback(() => {
    api
      .adminAudit(auditPage)
      .then(setAudit)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [auditPage]);

  useEffect(loadStats, [loadStats]);
  useEffect(loadAudit, [loadAudit]);

  const refresh = () => {
    loadStats();
    loadAudit();
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('Admin console')}</h1>
          <p className="muted">{t('Everything across the platform.')}</p>
        </div>
      </header>
      <ErrorNote message={error} />
      {stats && <Stats stats={stats} />}
      <UsersCard self={user} onChanged={refresh} />
      <OrganisationsCard onChanged={refresh} />
      {audit && (
        <section className="card">
          <h2>{t('Platform activity')}</h2>
          <AuditTable entries={audit.data} />
          <Pager meta={audit.meta} onPage={setAuditPage} />
        </section>
      )}
    </>
  );
};

/** Only works on the computer running the app, and only without a mail server. */
export const MailboxPage = () => {
  const [emails, setEmails] = useState<CapturedEmail[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => {
      api
        .mailbox()
        .then(setEmails)
        .catch((reason: ApiError) => setError(firstError(reason)));
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="page narrow">
      <a className="back" href="#/">
        {t('← Back')}
      </a>
      <header className="page-header">
        <div>
          <h1>{t('Local mailbox')}</h1>
          <p className="muted">
            {t(
              'Emails land here because no mail server is set up. Set SMTP_URL to send real ones.',
            )}
          </p>
        </div>
      </header>
      <ErrorNote message={error} />
      {emails?.length === 0 && <p className="empty card">{t('No emails yet.')}</p>}
      {emails?.map((email) => (
        <article key={email.id} className="card">
          <h2>{email.subject}</h2>
          <p className="muted small">
            {t('To {recipient} · {dateTime}', {
              recipient: email.recipient,
              dateTime: formatDateTime(email.createdAt),
            })}
          </p>
          <p className="mail-body">{email.body}</p>
          {email.link && <a href={email.link}>{t('Open link')}</a>}
          {email.attachments.length > 0 && (
            <ul className="attachments" aria-label={t('Attachments')}>
              {email.attachments.map((file) => (
                <li key={file.filename}>
                  <a
                    href={`data:${file.contentType};base64,${file.content}`}
                    download={file.filename}
                  >
                    {file.filename}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </main>
  );
};
