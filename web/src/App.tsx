import { useCallback, useEffect, useState } from 'react';
import { AccountPage } from './account';
import { AdminPage, MailboxPage } from './admin';
import { AlertsPage } from './alerts';
import { AssistantPage } from './assistant';
import { BillingPage } from './billing';
import { AudiencesPage } from './audiences';
import { api, setExpiredHandler, type User } from './api';
import { ComparePage } from './compare';
import { ReviewPage } from './creatives';
import {
  AcceptInvitation,
  ForgotPassword,
  Login,
  Register,
  ResetPassword,
  VerifyEmail,
} from './auth-pages';
import { ROLE_NAMES } from './format';
import { useTheme } from './hooks';
import { LanguagePicker } from './ui';
import { CampaignPage, Overview } from './pages';
import { ReportsPage } from './reports';
import { ActivityPage, TeamPage } from './team';
import { t } from './i18n';

interface Route {
  path: string;
  token: string;
}

const readRoute = (): Route => {
  const [path = '/', query = ''] = window.location.hash.slice(1).split('?');
  return { path: path || '/', token: new URLSearchParams(query).get('token') ?? '' };
};

const go = (path: string): void => {
  window.location.hash = `#${path}`;
};

const roleLabel = (user: User): string => {
  if (user.role === 'ADMIN') return t('Platform admin');
  if (user.role === 'GUEST') return t('Guest');
  return user.organisationRole ? ROLE_NAMES[user.organisationRole] : t('No organisation');
};

const App = () => {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [route, setRoute] = useState(readRoute);
  const [notice, setNotice] = useState('');
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    api
      .restore()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setRestoring(false));
  }, []);

  const reloadUser = useCallback(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  const signOut = useCallback(() => {
    void api.logout().then(() => {
      setUser(null);
      go('/');
    });
  }, []);

  useEffect(() => {
    setExpiredHandler(() => {
      setNotice(t('You were signed out. Please sign in again.'));
      setUser(null);
    });
  }, []);

  if (restoring) return null;

  if (route.path === '/mailbox') return <MailboxPage />;
  if (route.path === '/verify-email') return <VerifyEmail token={route.token} />;
  if (route.path === '/reset-password') return <ResetPassword token={route.token} />;
  if (route.path === '/invitation') {
    return (
      <AcceptInvitation
        token={route.token}
        user={user}
        onJoined={() => {
          setNotice(t('You joined the organisation. Sign in to continue.'));
          if (user) reloadUser();
          go('/');
        }}
      />
    );
  }

  if (!user) {
    if (route.path === '/register') return <Register />;
    if (route.path === '/forgot-password') return <ForgotPassword />;
    return (
      <Login
        notice={notice}
        onLogin={(signedIn) => {
          setNotice('');
          setUser(signedIn);
        }}
      />
    );
  }

  const isGuest = user.role === 'GUEST';
  const hasOrganisation = user.organisationId !== null;
  const seesActivity = user.organisationRole === 'OWNER' || user.organisationRole === 'MANAGER';
  // Owners and managers pay for campaigns; admins add credit and see revenue.
  const seesBilling = user.role === 'ADMIN' || (hasOrganisation && !isGuest && seesActivity);
  // Only ID characters, so a crafted link can't point API requests at another path.
  const campaignId = route.path.match(/^\/campaigns\/([\w-]+)$/)?.[1];
  const reportId = route.path.match(/^\/reports\/([\w-]+)$/)?.[1];

  const page = (() => {
    if (campaignId) {
      return <CampaignPage key={campaignId} id={campaignId} user={user} onBack={() => go('/')} />;
    }
    if (route.path === '/reports' || reportId) {
      return (
        <ReportsPage key={user.organisationId} user={user} {...(reportId ? { reportId } : {})} />
      );
    }
    if (route.path === '/compare') return <ComparePage key={user.organisationId} />;
    if (route.path === '/alerts') return <AlertsPage key={user.organisationId} />;
    if (route.path === '/billing' && seesBilling) {
      return <BillingPage key={user.organisationId} user={user} />;
    }
    if (route.path === '/assistant') return <AssistantPage key={user.organisationId} user={user} />;
    if (route.path === '/team' && hasOrganisation && !isGuest) {
      return <TeamPage key={user.organisationId} user={user} onChanged={reloadUser} />;
    }
    if (route.path === '/activity' && seesActivity) {
      return <ActivityPage key={user.organisationId} />;
    }
    if (route.path === '/audiences' && hasOrganisation && !isGuest) {
      return <AudiencesPage key={user.organisationId} user={user} />;
    }
    if (route.path === '/account' && !isGuest) {
      return <AccountPage user={user} onChanged={reloadUser} />;
    }
    if (route.path === '/admin' && user.role === 'ADMIN') return <AdminPage user={user} />;
    if (route.path === '/review' && user.role === 'ADMIN') return <ReviewPage />;
    return (
      <Overview key={user.organisationId} user={user} onOpen={(id) => go(`/campaigns/${id}`)} />
    );
  })();

  const links = [
    { path: '/', label: t('Overview'), show: true },
    { path: '/compare', label: t('Compare'), show: true },
    { path: '/reports', label: t('Reports'), show: true },
    { path: '/alerts', label: t('Alerts'), show: true },
    { path: '/assistant', label: t('Assistant'), show: true },
    { path: '/audiences', label: t('Audiences'), show: hasOrganisation && !isGuest },
    { path: '/team', label: t('Team'), show: hasOrganisation && !isGuest },
    { path: '/billing', label: t('Billing'), show: seesBilling },
    { path: '/activity', label: t('Activity'), show: seesActivity },
    { path: '/account', label: t('Account'), show: !isGuest },
    { path: '/admin', label: t('Admin'), show: user.role === 'ADMIN' },
    { path: '/review', label: t('Ad review'), show: user.role === 'ADMIN' },
  ].filter((link) => link.show);

  const isCurrent = (path: string): boolean =>
    path === '/'
      ? route.path === '/' || Boolean(campaignId)
      : route.path === path || (path === '/reports' && Boolean(reportId));

  return (
    <>
      <nav className="topbar" aria-label={t('Main')}>
        <div className="topbar-group">
          <a href="#/" className="brand">
            {t('Campaign Analytics')}
          </a>
          {links.map((link) => (
            <a
              key={link.path}
              href={`#${link.path}`}
              className="nav-link"
              aria-current={isCurrent(link.path) ? 'page' : undefined}
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="topbar-actions">
          {user.organisations.length > 1 ? (
            <select
              aria-label={t('Organisation')}
              value={user.organisationId ?? ''}
              onChange={(event) => {
                void api.switchOrganisation(event.target.value).then(() => {
                  go('/');
                  reloadUser();
                });
              }}
            >
              {user.organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted small who">{user.organisations[0]?.name}</span>
          )}
          <span className="muted small who">{roleLabel(user)}</span>
          <a className="button" href="/watch">
            {t('Demo site')}
          </a>
          <a className="button" href="/docs">
            {t('API docs')}
          </a>
          <LanguagePicker />
          <button type="button" className="button" onClick={toggle}>
            {theme === 'dark' ? t('Light theme') : t('Dark theme')}
          </button>
          <button type="button" className="button" onClick={signOut}>
            {t('Sign out')}
          </button>
        </div>
      </nav>
      <main className="page">
        {isGuest && (
          <p className="notice">
            {t('Read-only demo. All brands, shows and traffic are fictional.')}
          </p>
        )}
        {page}
      </main>
    </>
  );
};

export default App;
