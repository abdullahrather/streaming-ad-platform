import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type Campaign,
  type Member,
  type ReportDefinition,
  type ReportGrouping,
  type ReportResult,
  type ReportSchedule,
  type SavedReport,
  type User,
} from './api';
import { formatDateTime } from './format';
import { rangeFor } from './hooks';
import { ErrorNote, firstError } from './ui';
import { locale, t } from './i18n';

const GROUPINGS: Array<[ReportGrouping, string]> = [
  ['DAY', t('Day')],
  ['CAMPAIGN', t('Campaign')],
  ['SLOT', t('Ad slot')],
  ['COUNTRY', t('Country')],
  ['DEVICE', t('Device')],
  ['SHOW', t('Show')],
];

const COLUMNS: Array<[string, string, number]> = [
  ['impressions', t('Impressions'), 0],
  ['clicks', t('Clicks'), 0],
  ['ctr', t('CTR (%)'), 2],
  ['firstQuartileRate', t('Reached 25% (%)'), 1],
  ['midpointRate', t('Reached 50% (%)'), 1],
  ['thirdQuartileRate', t('Reached 75% (%)'), 1],
  ['completions', t('Completions'), 0],
  ['completionRate', t('Completion rate (%)'), 1],
  ['spend', t('Spend (€)'), 2],
  ['ecpm', t('eCPM (€)'), 2],
  ['reach', t('Reach'), 0],
  ['averageFrequency', t('Average frequency'), 2],
];

const CAMPAIGN_ONLY = ['reach', 'averageFrequency'];
const RANGE_DAYS = [1, 7, 14, 30, 90];
const WEEKDAYS = [
  t('Sunday'),
  t('Monday'),
  t('Tuesday'),
  t('Wednesday'),
  t('Thursday'),
  t('Friday'),
  t('Saturday'),
];

const DEFAULT: ReportDefinition = {
  campaignIds: [],
  groupBy: 'DAY',
  columns: ['impressions', 'clicks', 'ctr', 'completionRate', 'spend'],
  rangeDays: 7,
};

const format = (column: string, value: number | undefined): string => {
  const digits = COLUMNS.find(([id]) => id === column)?.[2] ?? 0;
  return (value ?? 0).toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const scheduleText = (report: SavedReport): string => {
  const hour = `${String(report.sendHour).padStart(2, '0')}:00`;
  if (report.schedule === 'DAILY') return t('Daily at {hour}', { hour });
  if (report.schedule === 'WEEKLY')
    return t('{weekday}s at {hour}', { weekday: WEEKDAYS[report.sendWeekday] ?? '', hour });
  return t('Not scheduled');
};

const canManage = (user: User): boolean =>
  user.role !== 'GUEST' &&
  (user.organisationRole === 'OWNER' || user.organisationRole === 'MANAGER');

const Preview = ({ result }: { result: ReportResult }) => {
  const groupLabel = GROUPINGS.find(([id]) => id === result.groupBy)?.[1] ?? '';
  const columns = COLUMNS.filter(([id]) => result.columns.includes(id));
  return (
    <div className="table-scroll">
      <table className="report-table">
        <caption className="sr-only">{t('Report preview')}</caption>
        <thead>
          <tr>
            <th scope="col">{groupLabel}</th>
            {columns.map(([id, label]) => (
              <th key={id} scope="col" className="num">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="empty">
                {t('No delivery in this period.')}
              </td>
            </tr>
          ) : (
            result.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {columns.map(([id]) => (
                  <td key={id} className="num">
                    {format(id, row.values[id])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{t('Total')}</th>
            {columns.map(([id]) => (
              <td key={id} className="num">
                {format(id, result.totals[id])}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

const SavedList = ({ reports, activeId }: { reports: SavedReport[]; activeId?: string }) => (
  <section className="card">
    <h2>{t('Saved reports')}</h2>
    {reports.length === 0 ? (
      <p className="empty">{t('No saved reports yet.')}</p>
    ) : (
      <ul className="rows">
        {reports.map((report) => (
          <li key={report.id}>
            <span>
              <a
                href={`#/reports/${report.id}`}
                aria-current={report.id === activeId ? 'page' : undefined}
              >
                {report.name}
              </a>
              <span className="muted small">
                {' '}
                · {scheduleText(report)}
                {report.nextRunAt
                  ? t(' · next {dateTime}', { dateTime: formatDateTime(report.nextRunAt) })
                  : ''}
                {report.lastSentAt
                  ? t(' · last sent {dateTime}', { dateTime: formatDateTime(report.lastSentAt) })
                  : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    )}
  </section>
);

export const ReportsPage = ({ user, reportId }: { user: User; reportId?: string }) => {
  const [definition, setDefinition] = useState<ReportDefinition>(DEFAULT);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<ReportSchedule>('NONE');
  const [sendWeekday, setSendWeekday] = useState(1);
  const [sendHour, setSendHour] = useState(8);
  const [recipientIds, setRecipientIds] = useState<string[]>([user.id]);
  const manages = canManage(user);
  const editing = reports.find((report) => report.id === reportId);

  const fail = (reason: unknown): void =>
    setError(reason instanceof ApiError ? firstError(reason) : String(reason));

  const loadReports = (): void => {
    api.reports().then(setReports).catch(fail);
  };

  useEffect(() => {
    api.analytics(rangeFor('30d')).then(setCampaigns).catch(fail);
    loadReports();
    if (user.organisationId && user.role !== 'GUEST') {
      api
        .members()
        .then(setMembers)
        .catch(() => setMembers([]));
    }
  }, [user.organisationId, user.role]);

  // Opening a saved report loads its settings into the builder.
  useEffect(() => {
    if (!editing) return;
    setDefinition({
      campaignIds: editing.campaignIds,
      groupBy: editing.groupBy,
      columns: editing.columns,
      rangeDays: editing.rangeDays,
    });
    setName(editing.name);
    setSchedule(editing.schedule);
    setSendWeekday(editing.sendWeekday);
    setSendHour(editing.sendHour);
    setRecipientIds(editing.recipientIds);
  }, [editing?.id]);

  // The preview follows every change, after a short pause. A slower, older request
  // must not overwrite a newer one, so a superseded response is ignored.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .runReport(definition)
        .then((data) => {
          if (!current) return;
          setResult(data);
          setError('');
        })
        .catch((reason: unknown) => {
          if (current) fail(reason);
        });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [definition]);

  const update = (change: Partial<ReportDefinition>): void =>
    setDefinition((current) => {
      const next = { ...current, ...change };
      // Reach can't be added up across rows, so it only stays when grouping by campaign.
      if (next.groupBy !== 'CAMPAIGN') {
        next.columns = next.columns.filter((column) => !CAMPAIGN_ONLY.includes(column));
      }
      if (next.columns.length === 0) next.columns = ['impressions'];
      return next;
    });

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  const save = (): void => {
    setNotice('');
    const input = { ...definition, name, schedule, sendWeekday, sendHour, recipientIds };
    const request = editing ? api.updateReport(editing.id, input) : api.saveReport(input);
    request
      .then((saved) => {
        setNotice(editing ? t('Report updated.') : t('Report saved.'));
        loadReports();
        window.location.hash = `#/reports/${saved.id}`;
      })
      .catch(fail);
  };

  const sendNow = (): void => {
    if (!editing) return;
    api
      .sendReport(editing.id)
      .then(({ sentTo }) => {
        setNotice(
          sentTo === 1 ? t('Sent to 1 person.') : t('Sent to {count} people.', { count: sentTo }),
        );
        loadReports();
      })
      .catch(fail);
  };

  const remove = (): void => {
    if (!editing || !window.confirm(t('Delete the report “{name}”?', { name: editing.name })))
      return;
    api
      .deleteReport(editing.id)
      .then(() => {
        window.location.hash = '#/reports';
        loadReports();
      })
      .catch(fail);
  };

  const download = (kind: 'csv' | 'pdf'): void => {
    api.exportReport(definition, kind).catch(fail);
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{editing ? editing.name : t('Reports')}</h1>
          <p className="muted">
            {t(
              'Build a report, download it as CSV or PDF, and save it to have it emailed every day or week.',
            )}
          </p>
        </div>
        {editing && (
          <a className="button" href="#/reports">
            {t('New report')}
          </a>
        )}
      </header>

      <ErrorNote message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="card report-builder">
        <h2>{t('What to include')}</h2>
        <div className="fields">
          <label>
            {t('Group rows by')}
            <select
              value={definition.groupBy}
              onChange={(event) => update({ groupBy: event.target.value as ReportGrouping })}
            >
              {GROUPINGS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Period')}
            <select
              value={definition.rangeDays}
              onChange={(event) => update({ rangeDays: Number(event.target.value) })}
            >
              {RANGE_DAYS.map((days) => (
                <option key={days} value={days}>
                  {days === 1 ? t('Last day') : t('Last {days} days', { days })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="checks">
          <legend>{t('Columns')}</legend>
          {COLUMNS.map(([id, label]) => {
            const unavailable = CAMPAIGN_ONLY.includes(id) && definition.groupBy !== 'CAMPAIGN';
            return (
              <label key={id} title={unavailable ? t('Group by campaign to use this') : undefined}>
                <input
                  type="checkbox"
                  checked={definition.columns.includes(id)}
                  disabled={unavailable}
                  onChange={() => update({ columns: toggle(definition.columns, id) })}
                />
                {label}
              </label>
            );
          })}
        </fieldset>
        {definition.groupBy !== 'CAMPAIGN' && (
          <p className="muted small">
            {t(
              "Reach and average frequency count unique viewers, which can't be added up across rows. Group by campaign to include them.",
            )}
          </p>
        )}

        <fieldset className="checks compare-picker">
          <legend>
            {t('Campaigns')}{' '}
            <span className="muted">
              ({definition.campaignIds.length === 0 ? 'all' : definition.campaignIds.length})
            </span>
          </legend>
          {campaigns.map((campaign) => (
            <label key={campaign.id}>
              <input
                type="checkbox"
                checked={definition.campaignIds.includes(campaign.id)}
                onChange={() =>
                  update({ campaignIds: toggle(definition.campaignIds, campaign.id) })
                }
              />
              {campaign.title}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>{t('Preview')}</h2>
          <div className="toolbar">
            <button type="button" className="button" onClick={() => download('csv')}>
              {t('Download CSV')}
            </button>
            <button type="button" className="button" onClick={() => download('pdf')}>
              {t('Download PDF')}
            </button>
          </div>
        </div>
        {result ? <Preview result={result} /> : <p className="empty">{t('Loading…')}</p>}
      </section>

      {manages && (
        <section className="card">
          <h2>{editing ? t('Schedule and recipients') : t('Save this report')}</h2>
          <div className="fields">
            <label className="wide">
              {t('Report name')}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              {t('Email it')}
              <select
                value={schedule}
                onChange={(event) => setSchedule(event.target.value as ReportSchedule)}
              >
                <option value="NONE">{t('Not by email')}</option>
                <option value="DAILY">{t('Every day')}</option>
                <option value="WEEKLY">{t('Every week')}</option>
              </select>
            </label>
            {schedule === 'WEEKLY' && (
              <label>
                {t('On')}
                <select
                  value={sendWeekday}
                  onChange={(event) => setSendWeekday(Number(event.target.value))}
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {schedule !== 'NONE' && (
              <label>
                {t('At')}
                <select
                  value={sendHour}
                  onChange={(event) => setSendHour(Number(event.target.value))}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {members.length > 0 && (
            <fieldset className="checks">
              <legend>{t('Send to')}</legend>
              {members.map((member) => (
                <label key={member.userId}>
                  <input
                    type="checkbox"
                    checked={recipientIds.includes(member.userId)}
                    onChange={() => setRecipientIds((current) => toggle(current, member.userId))}
                  />
                  {member.name || member.email}
                </label>
              ))}
            </fieldset>
          )}
          <p className="muted small">
            {t(
              'Times follow the platform time zone. Each email has the report attached as CSV and PDF, with a short summary and any open alerts.',
            )}
          </p>
          <div className="actions">
            {editing && (
              <>
                <button type="button" className="button danger" onClick={remove}>
                  {t('Delete')}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={sendNow}
                  disabled={editing.recipientIds.length === 0}
                >
                  {t('Send now')}
                </button>
              </>
            )}
            <button type="button" className="button primary" onClick={save}>
              {editing ? t('Save changes') : t('Save report')}
            </button>
          </div>
        </section>
      )}

      <SavedList reports={reports} {...(reportId ? { activeId: reportId } : {})} />
    </>
  );
};
