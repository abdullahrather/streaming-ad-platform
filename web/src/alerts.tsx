import { useState } from 'react';
import { api, type Alert, type AlertType } from './api';
import { formatDateTime } from './format';
import { useLiveData } from './hooks';
import { ErrorNote } from './ui';
import { t } from './i18n';

export const ALERT_LABELS: Record<AlertType, string> = {
  UNDER_DELIVERY: t('Delivery behind schedule'),
  BUDGET_BURN: t('Budget running out early'),
  SUDDEN_DROP: t('Sudden drop in impressions'),
};

/** The AI assistant's explanation, when it wrote one. Labelled so nobody mistakes it for a rule. */
const AlertExplanation = ({ alert }: { alert: Alert }) =>
  alert.details?.explanation ? (
    <p className="alert-explanation small">
      <span className="badge badge-neutral">{t('AI')}</span> {alert.details.explanation}
    </p>
  ) : null;

/** Open alerts, shown above a page's numbers. Shows nothing when all is well. */
export const OpenAlerts = ({ campaignId }: { campaignId?: string }) => {
  const { data } = useLiveData(() => api.alerts('open', campaignId), campaignId ?? 'all');
  if (!data || data.length === 0) return null;

  return (
    <section className="alert-strip" aria-label={t('Open alerts')}>
      <h2 className="alert-strip-title">
        <span aria-hidden="true">⚠</span>{' '}
        {data.length === 1 ? t('1 open alert') : t('{count} open alerts', { count: data.length })}
      </h2>
      <ul>
        {data.slice(0, 5).map((alert) => (
          <li key={alert.id}>
            <strong>{ALERT_LABELS[alert.type]}</strong>
            {campaignId ? null : (
              <>
                {' '}
                {t('on')} <a href={`#/campaigns/${alert.campaignId}`}>{alert.campaign.title}</a>
              </>
            )}
            <span className="muted">: {alert.message}</span>
            {campaignId ? <AlertExplanation alert={alert} /> : null}
          </li>
        ))}
      </ul>
      {data.length > 5 && (
        <a href="#/alerts" className="small">
          {t('See all {length} alerts', { length: data.length })}
        </a>
      )}
    </section>
  );
};

const AlertRow = ({ alert }: { alert: Alert }) => (
  <li className="alert-row">
    <div>
      <span className={`badge ${alert.resolvedAt ? 'badge-neutral' : 'badge-serious'}`}>
        {alert.resolvedAt ? t('Resolved') : t('Open')}
      </span>{' '}
      <strong>{ALERT_LABELS[alert.type]}</strong> {t('on')}{' '}
      <a href={`#/campaigns/${alert.campaignId}`}>{alert.campaign.title}</a>
      <span className="muted small"> · {alert.campaign.advertiser}</span>
    </div>
    <p>{alert.message}</p>
    <AlertExplanation alert={alert} />
    <p className="muted small">
      {alert.resolvedAt
        ? t('Opened {opened} · resolved {resolved}', {
            opened: formatDateTime(alert.openedAt),
            resolved: formatDateTime(alert.resolvedAt),
          })
        : t('Opened {opened}', { opened: formatDateTime(alert.openedAt) })}
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
          <h1>{t('Alerts')}</h1>
          <p className="muted">
            {t(
              'Running campaigns are checked every few minutes for delivery falling behind, budget running out early and sudden drops. Alerts resolve on their own when the problem clears.',
            )}
          </p>
        </div>
        <div className="segmented" role="group" aria-label={t('Which alerts')}>
          <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            {t('Open')}
          </button>
          <button type="button" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
            {t('All')}
          </button>
        </div>
      </header>
      <ErrorNote message={error} />
      {data ? (
        data.length === 0 ? (
          <p className="empty card">
            {status === 'open' ? t('No open alerts. Everything is on track.') : t('No alerts yet.')}
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
        !error && <p className="empty">{t('Loading…')}</p>
      )}
    </>
  );
};
