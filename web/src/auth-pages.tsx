import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type InvitationPreview, type Options, type User } from './api';
import { ROLE_NAMES } from './format';
import { LanguagePicker, firstError } from './ui';
import { language, t } from './i18n';

const GUEST = { email: 'guest@example.com', password: 'guest-demo' };
const LOCAL_ACCOUNTS = [
  { label: t('Owner'), email: 'advertiser@example.com', password: 'advert1234' },
  { label: t('Manager'), email: 'manager@example.com', password: 'manager1234' },
  { label: t('Analyst'), email: 'analyst@example.com', password: 'analyst1234' },
  { label: t('Admin'), email: 'admin@example.com', password: 'admin1234' },
];

const Shell = ({
  title,
  intro,
  onSubmit,
  error,
  notice,
  children,
}: {
  title: string;
  intro?: string;
  onSubmit?: (event: FormEvent) => void;
  error?: string;
  notice?: ReactNode;
  children?: ReactNode;
}) => (
  <main className="login">
    <form className="card login-card" onSubmit={onSubmit}>
      <h1>{title}</h1>
      {intro && <p className="muted">{intro}</p>}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {children}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <LanguagePicker />
    </form>
  </main>
);

const Field = ({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  minLength?: number;
}) => (
  <label>
    {label}
    <input
      type={type}
      value={value}
      autoComplete={autoComplete}
      minLength={minLength}
      required
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
);

const MailboxHint = ({ options }: { options: Options | null }) =>
  options?.localMailbox ? (
    <p className="hint">
      {t('No mail server is set up, so emails appear in the')}{' '}
      <a href="#/mailbox">{t('local mailbox')}</a>.
    </p>
  ) : null;

const useOptions = (): Options | null => {
  const [options, setOptions] = useState<Options | null>(null);
  useEffect(() => {
    api
      .options()
      .then(setOptions)
      .catch(() => setOptions(null));
  }, []);
  return options;
};

export const Login = ({ onLogin, notice }: { onLogin: (user: User) => void; notice?: string }) => {
  const options = useOptions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');

  const signIn = (address: string, secret: string) => {
    setError('');
    setUnverified(false);
    api
      .login(address, secret)
      .then((result) => {
        if ('twoFactorRequired' in result) setChallenge(result.challengeToken);
        else onLogin(result);
      })
      .catch((reason: ApiError) => {
        setUnverified(reason.code === 'EMAIL_NOT_VERIFIED');
        setError(firstError(reason));
      });
  };

  if (challenge) {
    const submitCode = (event: FormEvent) => {
      event.preventDefault();
      setError('');
      api
        .completeTwoFactor(challenge, code)
        .then(onLogin)
        .catch((reason: ApiError) => setError(firstError(reason)));
    };

    return (
      <Shell
        title={t('Two-factor login')}
        intro={t('Enter the code from your authenticator app, or a recovery code.')}
        onSubmit={submitCode}
        error={error}
      >
        <Field label={t('Code')} value={code} onChange={setCode} autoComplete="one-time-code" />
        <button type="submit" className="button primary">
          {t('Verify')}
        </button>
      </Shell>
    );
  }

  return (
    <Shell
      title={t('Campaign Analytics')}
      intro={t('Plan, run and measure ads across a streaming catalogue.')}
      notice={resent ? t('A new confirmation link is on its way.') : notice}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        signIn(email, password);
      }}
    >
      <Field
        label={t('Email')}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
      />
      <Field
        label={t('Password')}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <button type="submit" className="button primary">
        {t('Sign in')}
      </button>
      {unverified && (
        <button
          type="button"
          className="link"
          onClick={() => {
            setError('');
            setUnverified(false);
            api
              .resendVerification(email)
              .then(() => setResent(true))
              .catch((reason: ApiError) => setError(firstError(reason)));
          }}
        >
          {t('Send the confirmation email again')}
        </button>
      )}
      <div className="login-links">
        <a href="#/forgot-password">{t('Forgot password?')}</a>
        {options?.signUp && <a href="#/register">{t('Create an account')}</a>}
      </div>
      <MailboxHint options={options} />
      <div className="demo-accounts">
        <p className="hint">{t('Demo accounts')}</p>
        <button
          type="button"
          className="button"
          onClick={() => signIn(GUEST.email, GUEST.password)}
        >
          {t('Explore as guest')}
        </button>
        {options &&
          !options.demo &&
          LOCAL_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="button"
              onClick={() => signIn(account.email, account.password)}
            >
              {account.label}
            </button>
          ))}
      </div>
    </Shell>
  );
};

export const Register = () => {
  const options = useOptions();
  const [name, setName] = useState('');
  const [organisationName, setOrganisationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <Shell
        title={t('Check your email')}
        intro={t('We sent a confirmation link to {email}.', { email })}
      >
        <MailboxHint options={options} />
        <a href="#/">{t('Back to sign in')}</a>
      </Shell>
    );
  }

  return (
    <Shell
      title={t('Create an account')}
      intro={t('Your company gets its own private workspace.')}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        api
          .register({ name, organisationName, email, password })
          .then(() => setDone(true))
          .catch((reason: ApiError) => setError(firstError(reason)));
      }}
    >
      <Field label={t('Your name')} value={name} onChange={setName} autoComplete="name" />
      <Field
        label={t('Company name')}
        value={organisationName}
        onChange={setOrganisationName}
        autoComplete="organization"
      />
      <Field
        label={t('Work email')}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
      />
      <Field
        label={t('Password (at least 10 characters)')}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={10}
      />
      <button type="submit" className="button primary">
        {t('Create account')}
      </button>
      <a href="#/">{t('Already have an account? Sign in')}</a>
    </Shell>
  );
};

export const VerifyEmail = ({ token }: { token: string }) => {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const started = useRef(false);

  useEffect(() => {
    // The link works once, and React runs effects twice in development.
    if (started.current) return;
    started.current = true;

    api
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }, [token]);

  const copy = {
    working: t('Confirming your email…'),
    done: t('Your email is confirmed. You can sign in now.'),
    failed: t('This link is invalid or has expired. Sign in to get a new one.'),
  };

  return (
    <Shell title={t('Email confirmation')} intro={copy[state]}>
      {state !== 'working' && <a href="#/">{t('Go to sign in')}</a>}
    </Shell>
  );
};

export const ForgotPassword = () => {
  const options = useOptions();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  return (
    <Shell
      title={t('Reset your password')}
      intro={t("We'll email you a link to choose a new one.")}
      notice={sent ? t('If that account exists, a reset link is on its way.') : undefined}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        api
          .forgotPassword(email)
          .then(() => setSent(true))
          .catch((reason: ApiError) => setError(firstError(reason)));
      }}
    >
      <Field
        label={t('Email')}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
      />
      <button type="submit" className="button primary">
        {t('Send reset link')}
      </button>
      {sent && <MailboxHint options={options} />}
      <a href="#/">{t('Back to sign in')}</a>
    </Shell>
  );
};

export const ResetPassword = ({ token }: { token: string }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <Shell title={t('Password changed')} intro={t('Every device has been signed out.')}>
        <a href="#/">{t('Go to sign in')}</a>
      </Shell>
    );
  }

  return (
    <Shell
      title={t('Choose a new password')}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        api
          .resetPassword(token, password)
          .then(() => setDone(true))
          .catch((reason: ApiError) => setError(firstError(reason)));
      }}
    >
      <Field
        label={t('New password (at least 10 characters)')}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={10}
      />
      <button type="submit" className="button primary">
        {t('Change password')}
      </button>
    </Shell>
  );
};

export const AcceptInvitation = ({
  token,
  user,
  onJoined,
}: {
  token: string;
  user: User | null;
  onJoined: () => void;
}) => {
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .previewInvitation(token)
      .then(setPreview)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [token]);

  if (!preview) {
    return (
      <Shell title={t('Invitation')} error={error} intro={error ? undefined : t('Opening…')}>
        {error && <a href="#/">{t('Go to the dashboard')}</a>}
      </Shell>
    );
  }

  const intro = t('{email} is invited to join {organisation} as {role}.', {
    email: preview.email,
    organisation: preview.organisationName,
    // German nouns keep their capital letter.
    role: language === 'de' ? ROLE_NAMES[preview.role] : ROLE_NAMES[preview.role].toLowerCase(),
  });

  if (preview.hasAccount && user?.email !== preview.email) {
    return (
      <Shell title={t("You're invited")} intro={intro}>
        <p className="muted">
          {t('Sign in as {email}, then open this invitation link again.', { email: preview.email })}
        </p>
        <a href="#/">{t('Go to sign in')}</a>
      </Shell>
    );
  }

  return (
    <Shell
      title={t("You're invited")}
      intro={intro}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        api
          .acceptInvitation(token, name, password)
          .then(onJoined)
          .catch((reason: ApiError) => setError(firstError(reason)));
      }}
    >
      {!preview.hasAccount && (
        <>
          <Field label={t('Your name')} value={name} onChange={setName} autoComplete="name" />
          <Field
            label={t('Password (at least 10 characters)')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={10}
          />
        </>
      )}
      <button type="submit" className="button primary">
        {t('Join {organisationName}', { organisationName: preview.organisationName })}
      </button>
    </Shell>
  );
};
