import { useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Campaign, Pacing, PeriodTotals, Point, Row, Status, Totals } from './api';
import { formatCompact, formatEuros, formatNumber, formatPercent, formatTick } from './format';
import { RANGES } from './hooks';

const PACING: Record<Pacing, { label: string; icon: string; tone: string }> = {
  AHEAD: { label: 'Ahead', icon: '▲', tone: 'good' },
  ON_TRACK: { label: 'On track', icon: '●', tone: 'good' },
  BEHIND: { label: 'Behind', icon: '▼', tone: 'serious' },
  NOT_STARTED: { label: 'Not started', icon: '○', tone: 'neutral' },
  FINISHED: { label: 'Finished', icon: '■', tone: 'neutral' },
};

const STATUS: Record<Status, { label: string; tone: string }> = {
  ACTIVE: { label: 'Active', tone: 'good' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
};

export const PacingBadge = ({ pacing }: { pacing: Pacing }) => {
  const { label, icon, tone } = PACING[pacing];
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
};

export const StatusBadge = ({ status }: { status: Status }) => {
  const { label, tone } = STATUS[status];
  return <span className={`badge badge-${tone}`}>{label}</span>;
};

export const RangePicker = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) => (
  <div className="segmented" role="group" aria-label="Date range">
    {RANGES.map((range) => (
      <button
        key={range.id}
        type="button"
        aria-pressed={value === range.id}
        onClick={() => onChange(range.id)}
      >
        {range.label}
      </button>
    ))}
  </div>
);

interface Change {
  text: string;
  direction: 'up' | 'down' | 'flat';
  /** Spend going up isn't good or bad in itself, so it isn't coloured. */
  neutral?: boolean;
}

/** Percentage change for counts. Nothing to compare against gives null. */
const countChange = (current: number, previous: number, neutral = false): Change | null => {
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { text: 'No change', direction: 'flat', neutral };
  const sign = change > 0 ? '+' : '−';
  return {
    text: `${sign}${formatPercent(Math.abs(change), 0)}`,
    direction: change > 0 ? 'up' : 'down',
    neutral,
  };
};

/** Change in percentage points for rates, so 2% to 2.4% reads as +0.4 points. */
const rateChange = (current: number, previous: number, hadDelivery: boolean): Change | null => {
  if (!hadDelivery) return null;
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return { text: 'No change', direction: 'flat' };
  const sign = points > 0 ? '+' : '−';
  return {
    text: `${sign}${Math.abs(points).toFixed(1)} pts`,
    direction: points > 0 ? 'up' : 'down',
  };
};

/** A second description under the value, so the list stays a valid definition list. */
const ChangeNote = ({ change, period }: { change: Change | null; period: string }) => {
  if (!change) return <dd className="change muted">No earlier data</dd>;
  const icon = { up: '▲', down: '▼', flat: '●' }[change.direction];
  const tone = change.neutral || change.direction === 'flat' ? 'flat' : change.direction;
  return (
    <dd className={`change change-${tone}`}>
      <span aria-hidden="true">{icon}</span> {change.text}{' '}
      <span className="muted">vs {period}</span>
    </dd>
  );
};

export interface Kpi {
  label: string;
  value: string;
  change?: Change | null;
}

export const Kpis = ({
  totals,
  spendCents,
  previous,
  period = 'previous period',
  extra = [],
}: {
  totals: Totals;
  spendCents: number;
  /** The period before, for showing change. */
  previous?: PeriodTotals;
  period?: string;
  extra?: Kpi[];
}) => {
  const hadDelivery = (previous?.impressions ?? 0) > 0;
  const items: Kpi[] = [
    {
      label: 'Impressions',
      value: formatCompact(totals.impressions),
      ...(previous ? { change: countChange(totals.impressions, previous.impressions) } : {}),
    },
    {
      label: 'Clicks',
      value: formatCompact(totals.clicks),
      ...(previous ? { change: countChange(totals.clicks, previous.clicks) } : {}),
    },
    {
      label: 'Click-through rate',
      value: formatPercent(totals.ctr, 2),
      ...(previous ? { change: rateChange(totals.ctr, previous.ctr, hadDelivery) } : {}),
    },
    {
      label: 'Ads watched to the end',
      value: formatPercent(totals.completionRate),
      ...(previous
        ? { change: rateChange(totals.completionRate, previous.completionRate, hadDelivery) }
        : {}),
    },
    {
      label: 'Spend',
      value: formatEuros(spendCents),
      ...(previous ? { change: countChange(spendCents, previous.spendCents, true) } : {}),
    },
    ...extra,
  ];
  return (
    <dl className="kpis">
      {items.map((item) => (
        <div key={item.label} className="card kpi">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.change !== undefined && <ChangeNote change={item.change} period={period} />}
        </div>
      ))}
    </dl>
  );
};

export { countChange };

const isHourly = (points: Point[]): boolean => {
  if (points.length < 2) return true;
  const first = new Date((points[0] as Point).time).getTime();
  const second = new Date((points[1] as Point).time).getTime();
  return second - first <= 3_600_000;
};

const TrendTooltip = ({
  active,
  payload,
  label,
  hourly,
  unit,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ value?: unknown }>;
  label?: string | number;
  hourly: boolean;
  unit: string;
}) => {
  if (!active || !payload?.length || !label) return null;
  const when = new Date(label).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(hourly ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  return (
    <div className="tooltip">
      <div className="tooltip-label">{when}</div>
      <strong>{formatNumber(Number(payload[0]?.value ?? 0))}</strong> {unit}
    </div>
  );
};

/** One measure per chart, each on its own axis. */
const Trend = ({
  title,
  dataKey,
  points,
}: {
  title: string;
  dataKey: 'impressions' | 'clicks';
  points: Point[];
}) => {
  const hourly = isHourly(points);
  const gradient = `fill-${dataKey}`;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="time"
            tickFormatter={(value: string) => formatTick(value, hourly)}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--axis)' }}
            minTickGap={48}
          />
          <YAxis
            tickFormatter={formatCompact}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            content={(props) => (
              <TrendTooltip
                active={props.active}
                payload={props.payload}
                label={props.label}
                hourly={hourly}
                unit={dataKey}
              />
            )}
            cursor={{ stroke: 'var(--axis)' }}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="var(--series-1)"
            strokeWidth={2}
            fill={`url(#${gradient})`}
            activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
};

const TrendTable = ({ points }: { points: Point[] }) => {
  const hourly = isHourly(points);
  return (
    <div className="table-scroll trend-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col" className="num">
              Impressions
            </th>
            <th scope="col" className="num">
              Clicks
            </th>
            <th scope="col" className="num">
              CTR
            </th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((point) => (
            <tr key={point.time}>
              <td>{formatTick(point.time, hourly)}</td>
              <td className="num">{formatNumber(point.impressions)}</td>
              <td className="num">{formatNumber(point.clicks)}</td>
              <td className="num">{formatPercent(point.ctr, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const Trends = ({ points }: { points: Point[] }) => {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card">
      <header className="card-header">
        <h2>Performance over time</h2>
        <button type="button" className="link" onClick={() => setAsTable((value) => !value)}>
          {asTable ? 'Show charts' : 'Show table'}
        </button>
      </header>
      {points.length === 0 ? (
        <p className="empty">No delivery in this period.</p>
      ) : asTable ? (
        <TrendTable points={points} />
      ) : (
        <div className="charts">
          <Trend title="Impressions" dataKey="impressions" points={points} />
          <Trend title="Clicks" dataKey="clicks" points={points} />
        </div>
      )}
    </section>
  );
};

/** Ranked bars: the length shows impressions, and the numbers stay readable beside them. */
export const Breakdown = ({
  title,
  rows,
  labels,
}: {
  title: string;
  rows: Row[];
  labels?: Record<string, string>;
}) => {
  const largest = Math.max(...rows.map((row) => row.impressions), 1);
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">No delivery in this period.</p>
      ) : (
        <ul className="bars">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="bar-label">
                <span>{labels?.[row.key] ?? row.key}</span>
                <span className="bar-value">
                  {formatCompact(row.impressions)} · {formatPercent(row.ctr, 2)} CTR ·{' '}
                  {formatPercent(row.completionRate, 0)} finished
                </span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(row.impressions / largest) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const DROP_OFF_STAGES = [
  ['firstQuartiles', '25%'],
  ['midpoints', '50%'],
  ['thirdQuartiles', '75%'],
  ['completions', 'End'],
] as const;

/** Where viewers stop watching, compared across slots, devices or shows. */
export const DropOffBySegment = ({
  groups,
}: {
  groups: Array<{ id: string; label: string; rows: Row[]; labels?: Record<string, string> }>;
}) => {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const group = groups.find((candidate) => candidate.id === groupId) ?? groups[0];
  if (!group) return null;
  const rows = group.rows.filter((row) => row.impressions > 0);

  return (
    <section className="card">
      <div className="card-header">
        <h2>Where viewers stop watching</h2>
        <div className="segmented" role="group" aria-label="Compare drop-off by">
          {groups.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={candidate.id === group.id}
              onClick={() => setGroupId(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No delivery in this period.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Share of viewers still watching at each point, by {group.label.toLowerCase()}
            </caption>
            <thead>
              <tr>
                <th scope="col">{group.label}</th>
                <th scope="col" className="num">
                  Started
                </th>
                {DROP_OFF_STAGES.map(([, label]) => (
                  <th key={label} scope="col" className="num">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{group.labels?.[row.key] ?? row.key}</th>
                  <td className="num">{formatCompact(row.impressions)}</td>
                  {DROP_OFF_STAGES.map(([field, label]) => (
                    <td key={label} className="num">
                      {formatPercent(row[field] / row.impressions, 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

/** What was promised at launch, against what has happened so far. */
export const ForecastComparison = ({ campaign, reach }: { campaign: Campaign; reach: number }) => {
  const { forecastImpressions, forecastReach, lifetimeImpressions } = campaign;
  if (forecastImpressions === null) return null;

  const rows = [
    ['Impressions', lifetimeImpressions, forecastImpressions],
    ['Reach', reach, forecastReach ?? 0],
  ] as const;

  return (
    <section className="card">
      <h2>Forecast against delivery</h2>
      {rows.map(([label, actual, expected]) => (
        <div key={label} className="goal">
          <div className="bar-label">
            <span>{label}</span>
            <span className="bar-value">
              {formatNumber(actual)} of {formatNumber(expected)} forecast
            </span>
          </div>
          <Progress label={`${label} against forecast`} rate={expected ? actual / expected : 0} />
        </div>
      ))}
    </section>
  );
};

const FILTER_REASONS: Record<string, string> = {
  BOT_USER_AGENT: 'Bots and crawlers',
  EXCESSIVE_REQUESTS: 'Too many requests from one viewer',
  IMPOSSIBLE_TIMING: 'Finished impossibly fast',
};

/** Traffic that was rejected, so it was never counted or charged. */
export const FilteredTraffic = ({ rows }: { rows: Array<{ reason: string; count: number }> }) =>
  rows.length === 0 ? null : (
    <section className="card">
      <h2>Invalid traffic removed</h2>
      <p className="muted small">Not counted in these results, and not charged.</p>
      <ul className="rows">
        {rows.map(({ reason, count }) => (
          <li key={reason}>
            <span>{FILTER_REASONS[reason] ?? reason}</span>
            <span className="bar-value">{formatNumber(count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );

/** How far viewers get through an ad, as a share of everyone who started it. */
export const ViewerDropOff = ({ totals }: { totals: Totals }) => {
  const stages = [
    ['Started', totals.impressions],
    ['Reached 25%', totals.firstQuartiles],
    ['Reached 50%', totals.midpoints],
    ['Reached 75%', totals.thirdQuartiles],
    ['Watched to the end', totals.completions],
  ] as const;

  return (
    <section className="card">
      <h2>How far viewers watch</h2>
      {totals.impressions === 0 ? (
        <p className="empty">No delivery in this period.</p>
      ) : (
        <ul className="bars">
          {stages.map(([label, value]) => (
            <li key={label}>
              <div className="bar-label">
                <span>{label}</span>
                <span className="bar-value">
                  {formatCompact(value)} · {formatPercent(value / totals.impressions, 0)}
                </span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(value / totals.impressions) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const Progress = ({ label, rate }: { label: string; rate: number }) => (
  <div
    className="progress"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(Math.min(rate, 1) * 100)}
  >
    <div style={{ width: `${Math.min(rate, 1) * 100}%` }} />
  </div>
);

export const sumTotals = (campaigns: Campaign[]): Totals & { spendCents: number } => {
  const impressions = campaigns.reduce((sum, c) => sum + c.impressions, 0);
  const clicks = campaigns.reduce((sum, c) => sum + c.clicks, 0);
  const firstQuartiles = campaigns.reduce((sum, c) => sum + c.firstQuartiles, 0);
  const midpoints = campaigns.reduce((sum, c) => sum + c.midpoints, 0);
  const thirdQuartiles = campaigns.reduce((sum, c) => sum + c.thirdQuartiles, 0);
  const completions = campaigns.reduce((sum, c) => sum + c.completions, 0);
  return {
    impressions,
    clicks,
    firstQuartiles,
    midpoints,
    thirdQuartiles,
    completions,
    ctr: impressions ? clicks / impressions : 0,
    completionRate: impressions ? completions / impressions : 0,
    spendCents: campaigns.reduce((sum, c) => sum + c.spendCents, 0),
  };
};
