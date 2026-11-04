import { useState } from 'react';
import { api, type Alert, type AlertType } from './api';
import { formatDateTime } from './format';
import { useLiveData } from './hooks';
import { ErrorNote } from './ui';

export const ALERT_LABELS: Record<AlertType, string> = {
  UNDER_DELIVERY: 'Delivery behind schedule',
  BUDGET_BURN: 'Budget running out early',
  SUDDEN_DROP: 'Sudden drop in impressions',
};

/** Open alerts, shown above a page's numbers. Shows nothing when all is well. */
export const OpenAlerts = ({ campaignId }: { campaignId?: string }) => {
  const { data } = useLiveData(() => api.alerts('open', campaignId), campaignId ?? 'all');
  if (!data || data.length === 0) return null;

  return (
    <section className="alert-strip" aria-label="Open alerts">
      <h2 className="alert-strip-title">
        <span aria-hidden="true">⚠</span> {data.length} open alert{data.length === 1 ? '' : 's'}
      </h2>
      <ul>
        {data.slice(0, 5).map((alert) => (
          <li key={alert.id}>
            <strong>{ALERT_LABELS[alert.type]}</strong>
            {campaignId ? null : (
              <>
                {' '}
                on <a href={`#/campaigns/${alert.campaignId}`}>{alert.campaign.title}</a>
              </>
            )}
            <span className="muted">: {alert.message}</span>
          </li>
        ))}
      </ul>
      {data.length > 5 && (
        <a href="#/alerts" className="small">
          See all {data.length} alerts
        </a>
      )}
    </section>
  );
};

const AlertRow = ({ alert }: { alert: Alert }) => (
  <li className="alert-row">
    <div>
      <span className={`badge ${alert.resolvedAt ? 'badge-neutral' : 'badge-serious'}`}>
        {alert.resolvedAt ? 'Resolved' : 'Open'}
      </span>{' '}
      <strong>{ALERT_LABELS[alert.type]}</strong> on{' '}
      <a href={`#/campaigns/${alert.campaignId}`}>{alert.campaign.title}</a>
      <span className="muted small"> · {alert.campaign.advertiser}</span>
    </div>
    <p>{alert.message}</p>
    <p className="muted small">
      Opened {formatDateTime(alert.openedAt)}
      {alert.resolvedAt ? ` · resolved ${formatDateTime(alert.resolvedAt)}` : ''}
    </p>
  </li>
);

export const AlertsPage = () => {
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const { data, error } = useLiveData(() => api.alerts(status), status);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Alerts</h1>
          <p className="muted">
            Running campaigns are checked every few minutes for delivery falling behind, budget
            running out early and sudden drops. Alerts resolve on their own when the problem clears.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Which alerts">
          <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            Open
          </button>
          <button type="button" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
            All
          </button>
        </div>
      </header>
      <ErrorNote message={error} />
      {data ? (
        data.length === 0 ? (
          <p className="empty card">
            {status === 'open' ? 'No open alerts. Everything is on track.' : 'No alerts yet.'}
          </p>
        ) : (
          <section className="card">
            <ul className="alert-list">
              {data.map((alert) => (
                <AlertRow key={alert.id} alert={alert} />
              ))}
            </ul>
          </section>
        )
      ) : (
        !error && <p className="empty">Loading…</p>
      )}
    </>
  );
};
