import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type AuditEntry,
  type Invitation,
  type Member,
  type OrganisationRole,
  type Page,
  type User,
} from './api';
import { ROLE_DESCRIPTIONS, ROLE_NAMES, formatDate } from './format';
import { AuditTable, ErrorNote, Pager, firstError } from './ui';
import { t } from './i18n';

const ROLES: OrganisationRole[] = ['OWNER', 'MANAGER', 'ANALYST'];

const RoleSelect = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OrganisationRole;
  onChange: (role: OrganisationRole) => void;
}) => (
  <select
    aria-label={label}
    value={value}
    onChange={(event) => onChange(event.target.value as OrganisationRole)}
  >
    {ROLES.map((role) => (
      <option key={role} value={role}>
        {ROLE_NAMES[role]}
      </option>
    ))}
  </select>
);

export const TeamPage = ({ user, onChanged }: { user: User; onChanged: () => void }) => {
  const isOwner = user.organisationRole === 'OWNER';
  const canSeeInvitations = isOwner || user.organisationRole === 'MANAGER';
  const organisation = user.organisations.find(({ id }) => id === user.organisationId);

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganisationRole>('ANALYST');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api
      .members()
      .then(setMembers)
      .catch((reason: ApiError) => setError(firstError(reason)));
    if (canSeeInvitations) {
      api
        .invitations()
        .then(setInvitations)
        .catch((reason: ApiError) => setError(firstError(reason)));
    }
  }, [canSeeInvitations]);

  useEffect(load, [load]);

  const act = (action: Promise<void>, done?: string) => {
    setError('');
    setNotice('');
    action
      .then(() => {
        if (done) setNotice(done);
        load();
      })
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    act(
      api.invite(email, role).then(() => setEmail('')),
      t('Invitation sent to {email}.', { email }),
    );
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('Team')}</h1>
          <p className="muted">{organisation?.name}</p>
        </div>
      </header>

      <ErrorNote message={error} />
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}

      <section className="card">
        <h2>{t('Members')}</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('Name')}</th>
                <th scope="col">{t('Role')}</th>
                <th scope="col">{t('Joined')}</th>
                <th scope="col">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    {member.name || member.email}
                    <div className="muted small">{member.email}</div>
                  </td>
                  <td>
                    {isOwner ? (
                      <RoleSelect
                        label={t('Role for {email}', { email: member.email })}
                        value={member.role}
                        onChange={(next) => act(api.changeRole(member.userId, next))}
                      />
                    ) : (
                      ROLE_NAMES[member.role]
                    )}
                  </td>
                  <td className="nowrap">{formatDate(member.joinedAt)}</td>
                  <td className="actions-cell">
                    {member.userId === user.id ? (
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          if (window.confirm(t('Leave this organisation?'))) {
                            act(api.removeMember(member.userId).then(onChanged));
                          }
                        }}
                      >
                        {t('Leave')}
                      </button>
                    ) : (
                      isOwner && (
                        <button
                          type="button"
                          className="button danger"
                          onClick={() => {
                            if (window.confirm(t('Remove {email}?', { email: member.email }))) {
                              act(api.removeMember(member.userId));
                            }
                          }}
                        >
                          {t('Remove')}
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner && (
        <section className="card">
          <h2>{t('Invite someone')}</h2>
          <form className="inline-form" onSubmit={invite}>
            <label>
              {t('Email')}
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              {t('Role')}
              <RoleSelect label={t('Role')} value={role} onChange={setRole} />
            </label>
            <button type="submit" className="button primary">
              {t('Send invitation')}
            </button>
          </form>
          <p className="hint">{ROLE_DESCRIPTIONS[role]}</p>
        </section>
      )}

      {canSeeInvitations && invitations.length > 0 && (
        <section className="card">
          <h2>{t('Open invitations')}</h2>
          <ul className="rows">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <span>
                  {invitation.email}
                  <span className="muted small">
                    {' '}
                    {t('· {value} · expires {date}', {
                      value: ROLE_NAMES[invitation.role],
                      date: formatDate(invitation.expiresAt),
                    })}
                  </span>
                </span>
                {isOwner && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => act(api.cancelInvitation(invitation.id))}
                  >
                    {t('Cancel')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
};

export const ActivityPage = () => {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AuditEntry> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .teamAudit(page)
      .then(setResult)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [page]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('Activity')}</h1>
          <p className="muted">{t('Who changed what in this organisation.')}</p>
        </div>
      </header>
      <ErrorNote message={error} />
      {result && (
        <section className="card">
          <AuditTable entries={result.data} />
          <Pager meta={result.meta} onPage={setPage} />
        </section>
      )}
    </>
  );
};
