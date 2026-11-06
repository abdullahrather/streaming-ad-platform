import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Device, type User } from './api';
import { formatDateTime } from './format';
import { ErrorNote, firstError } from './ui';

const describeDevice = (userAgent: string): string => {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Unknown browser';
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'unknown system';
  return `${browser} on ${system}`;
};

const ProfileCard = ({ user, onChanged }: { user: User; onChanged: () => void }) => {
  const [name, setName] = useState(user.name);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <section className="card">
      <h2>Profile</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          setSaved(false);
          api
            .updateProfile(name)
            .then(() => {
              setSaved(true);
              onChanged();
            })
            .catch((reason: ApiError) => setError(firstError(reason)));
        }}
      >
        <label>
          Email
          <input value={user.email} readOnly />
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
          />
        </label>
        <ErrorNote message={error} />
        {saved && (
          <p className="success" role="status">
            Saved.
          </p>
        )}
        <div>
          <button type="submit" className="button primary">
            Save
          </button>
        </div>
      </form>
    </section>
  );
};

const PasswordCard = ({ onChanged }: { onChanged: () => void }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaved(false);
    api
      .changePassword(currentPassword, newPassword)
      .then(() => {
        setCurrentPassword('');
        setNewPassword('');
        setSaved(true);
        onChanged();
      })
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  return (
    <section className="card">
      <h2>Password</h2>
      <form className="stack" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </label>
        <label>
          New password (at least 10 characters)
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={10}
            required
          />
        </label>
        <ErrorNote message={error} />
        {saved && (
          <p className="success" role="status">
            Password changed. Other devices were signed out.
          </p>
        )}
        <div>
          <button type="submit" className="button primary">
            Change password
          </button>
        </div>
      </form>
    </section>
  );
};

const TwoFactorCard = ({ user, onChanged }: { user: User; onChanged: () => void }) => {
  const [setup, setSetup] = useState<{ secret: string; qrCode: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState('');

  const fail = (reason: ApiError) => setError(firstError(reason));

  if (recoveryCodes.length > 0) {
    return (
      <section className="card">
        <h2>Save your recovery codes</h2>
        <p className="muted">
          Each code works once if you lose your authenticator. This is the only time they're shown.
        </p>
        <ul className="codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>{recoveryCode}</li>
          ))}
        </ul>
        <button type="button" className="button primary" onClick={() => setRecoveryCodes([])}>
          I've saved them
        </button>
      </section>
    );
  }

  if (user.twoFactorEnabled) {
    return (
      <section className="card">
        <h2>Two-factor login</h2>
        <p className="muted">On. Enter your password and a code to turn it off.</p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            api
              .disableTwoFactor(password, code)
              .then(() => {
                setPassword('');
                setCode('');
                onChanged();
              })
              .catch(fail);
          }}
        >
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label>
            Authenticator or recovery code
            <input
              value={code}
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
          <ErrorNote message={error} />
          <div>
            <button type="submit" className="button danger">
              Turn off
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (setup) {
    return (
      <section className="card">
        <h2>Set up two-factor login</h2>
        <p className="muted">Scan this with an authenticator app, then enter the code it shows.</p>
        <img className="qr" src={setup.qrCode} alt="QR code for your authenticator app" />
        <p className="hint">
          Can't scan it? Enter this key: <code>{setup.secret}</code>
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            api
              .enableTwoFactor(code)
              .then(({ recoveryCodes: codes }) => {
                setSetup(null);
                setCode('');
                setRecoveryCodes(codes);
                onChanged();
              })
              .catch(fail);
          }}
        >
          <label>
            Code from your app
            <input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
          <ErrorNote message={error} />
          <div>
            <button type="submit" className="button primary">
              Turn on
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Two-factor login</h2>
      <p className="muted">Protect your account with a code from an authenticator app.</p>
      <ErrorNote message={error} />
      <div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setError('');
            api.startTwoFactor().then(setSetup).catch(fail);
          }}
        >
          Set up
        </button>
      </div>
    </section>
  );
};

const DevicesCard = ({ refreshKey }: { refreshKey: number }) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .devices()
      .then(setDevices)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, []);

  useEffect(load, [load, refreshKey]);

  const others = devices.filter((device) => !device.current);

  return (
    <section className="card">
      <header className="card-header">
        <h2>Signed-in devices</h2>
        {others.length > 0 && (
          <button
            type="button"
            className="link"
            onClick={() => {
              api.signOutOthers().then(load).catch(load);
            }}
          >
            Sign out all others
          </button>
        )}
      </header>
      <ErrorNote message={error} />
      <ul className="rows">
        {devices.map((device) => (
          <li key={device.id}>
            <span>
              {describeDevice(device.userAgent)}
              {device.current && <span className="badge badge-good">This device</span>}
              <div className="muted small">Last active {formatDateTime(device.lastUsedAt)}</div>
            </span>
            {!device.current && (
              <button
                type="button"
                className="button"
                aria-label={`Sign out ${describeDevice(device.userAgent)}`}
                onClick={() => {
                  api.signOutDevice(device.id).then(load).catch(load);
                }}
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

const AlertsCard = ({ user, onChanged }: { user: User; onChanged: () => void }) => {
  const [error, setError] = useState('');
  // The box changes at once, and goes back if saving fails.
  const [enabled, setEnabled] = useState(user.alertEmails);
  if (!user.organisationId) return null;

  return (
    <section className="card">
      <h2>Campaign alerts</h2>
      <p className="muted small">
        Emails you when a campaign in{' '}
        {user.organisations.find(({ id }) => id === user.organisationId)?.name ??
          'this organisation'}{' '}
        falls behind, is running out of budget early or drops suddenly. Alerts always show on the
        Alerts page.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const wanted = event.target.checked;
            setError('');
            setEnabled(wanted);
            api
              .setAlertEmails(wanted)
              .then(onChanged)
              .catch((reason: Error) => {
                setEnabled(!wanted);
                setError(reason.message);
              });
          }}
        />
        Email me campaign alerts
      </label>
      <ErrorNote message={error} />
    </section>
  );
};

/** A copy of everything held about the person, and deleting their account. */
const DataCard = () => {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const download = () => {
    setError('');
    api.exportAccount().catch((reason: ApiError) => setError(firstError(reason)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    api
      .deleteAccount(password)
      // Every session has ended, so starting again shows the sign-in page.
      .then(() => window.location.assign('/'))
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  return (
    <section className="card">
      <h2>Your data</h2>
      <p className="muted">
        Download a copy of everything held about you: your profile, teams, devices and activity.
      </p>
      <div>
        <button type="button" className="button" onClick={download}>
          Download my data
        </button>
      </div>
      {confirming ? (
        <form className="stack" onSubmit={submit}>
          <p>
            Deleting your account signs you out everywhere and removes your name and email. Your
            teams keep their campaigns, reports and invoices.
          </p>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <ErrorNote message={error} />
          <div className="actions">
            <button type="submit" className="button danger">
              Delete my account
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote message={error} />
          <div>
            <button type="button" className="button danger" onClick={() => setConfirming(true)}>
              Delete my account…
            </button>
          </div>
        </>
      )}
    </section>
  );
};

export const AccountPage = ({ user, onChanged }: { user: User; onChanged: () => void }) => {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Account</h1>
          <p className="muted">{user.email}</p>
        </div>
      </header>
      <div className="columns">
        <ProfileCard user={user} onChanged={onChanged} />
        <PasswordCard onChanged={() => setRefreshKey((key) => key + 1)} />
        <TwoFactorCard user={user} onChanged={onChanged} />
        <AlertsCard user={user} onChanged={onChanged} />
        <DevicesCard refreshKey={refreshKey} />
        <DataCard />
      </div>
    </>
  );
};
