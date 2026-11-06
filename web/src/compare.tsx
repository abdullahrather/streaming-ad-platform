import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Campaign, type Compared } from './api';
import { PacingBadge, RangePicker } from './components';
import {
  formatCompact,
  formatCpm,
  formatEuros,
  formatNumber,
  formatPercent,
  formatTick,
  formatDecimal,
} from './format';
import { rangeFor, useLiveData } from './hooks';
import { ErrorNote } from './ui';
import { t } from './i18n';

const MAX = 4;
const SLOTS = [1, 2, 3, 4];
const CHART_HEIGHT = 260;
const PLOT_TOP = 8;
// Recharts reserves 30px for the x-axis under the plot.
const PLOT_HEIGHT = CHART_HEIGHT - PLOT_TOP - 30;
const LABEL_GAP = 14;

/** Each campaign keeps its colour slot while selected, so removing one never repaints the rest. */
const useSlots = (ids: string[]): Map<string, number> => {
  const [slots, setSlots] = useState(new Map<string, number>());
  useEffect(() => {
    setSlots((previous) => {
      const next = new Map([...previous].filter(([id]) => ids.includes(id)));
      for (const id of ids) {
        if (next.has(id)) continue;
        const used = new Set(next.values());
        next.set(id, SLOTS.find((slot) => !used.has(slot)) ?? 1);
      }
      return next;
    });
  }, [ids]);
  return slots;
};

const colour = (slot: number | undefined): string => `var(--series-${slot ?? 1})`;

const Swatch = ({ slot }: { slot: number | undefined }) => (
  <span className="swatch" style={{ background: colour(slot) }} aria-hidden="true" />
);

type MetricRow = [
  label: string,
  value: (row: Compared) => number,
  format: (value: number) => string,
];

const METRICS: MetricRow[] = [
  [t('Impressions'), (row) => row.campaign.impressions, formatNumber],
  [t('Reach'), (row) => row.reach, formatNumber],
  [
    t('Average frequency'),
    (row) => row.averageFrequency,
    (value) => (value ? `${formatDecimal(value)}×` : '–'),
  ],
  [t('Clicks'), (row) => row.campaign.clicks, formatNumber],
  [t('Click-through rate'), (row) => row.campaign.ctr, (value) => formatPercent(value, 2)],
  [t('Watched to the end'), (row) => row.campaign.completionRate, (value) => formatPercent(value)],
  [t('Spend'), (row) => row.campaign.spendCents, formatEuros],
  [
    t('Cost per 1,000 (eCPM)'),
    (row) =>
      row.campaign.impressions ? (row.campaign.spendCents / row.campaign.impressions) * 1000 : 0,
    formatCpm,
  ],
  [t('Goal delivered'), (row) => row.campaign.deliveryRate, (value) => formatPercent(value, 0)],
];

const CompareChart = ({ rows, slots }: { rows: Compared[]; slots: Map<string, number> }) => {
  const points = useMemo(() => {
    const byTime = new Map<string, Record<string, number | string>>();
    for (const row of rows) {
      for (const point of row.timeseries) {
        const entry = byTime.get(point.time) ?? { time: point.time };
        entry[row.campaign.id] = point.impressions;
        byTime.set(point.time, entry);
      }
    }
    return [...byTime.values()].sort((a, b) => String(a['time']).localeCompare(String(b['time'])));
  }, [rows]);

  if (points.length === 0) return <p className="empty">{t('No delivery in this period.')}</p>;

  // A fixed, rounded top for the axis tells us where each line ends, so the end labels
  // can be spaced apart when two lines finish close together.
  const highest = Math.max(
    1,
    ...points.flatMap((point) => rows.map((row) => Number(point[row.campaign.id] ?? 0))),
  );
  const step = 10 ** Math.floor(Math.log10(highest));
  const top = ([1, 2, 2.5, 5, 10].find((factor) => factor * step >= highest * 1.05) ?? 10) * step;
  const endY = (value: number): number => PLOT_TOP + PLOT_HEIGHT * (1 - value / top);
  const ends = rows
    .map((row) => ({ id: row.campaign.id, y: endY(Number(points.at(-1)?.[row.campaign.id] ?? 0)) }))
    .sort((a, b) => a.y - b.y);
  const labelShift = new Map<string, number>();
  let previousY = -Infinity;
  for (const end of ends) {
    const y = Math.max(end.y, previousY + LABEL_GAP);
    labelShift.set(end.id, y - end.y);
    previousY = y;
  }

  const hourly =
    points.length < 2 ||
    new Date(String(points[1]?.['time'])).getTime() -
      new Date(String(points[0]?.['time'])).getTime() <=
      3_600_000;
  const last = points.length - 1;

  return (
    <figure className="chart">
      <figcaption>{t('Impressions over time')}</figcaption>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={points} margin={{ top: PLOT_TOP, right: 96, bottom: 0, left: 0 }}>
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
            domain={[0, top]}
            tickFormatter={formatCompact}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: 'var(--axis)' }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="tooltip">
                  <p className="tooltip-label">{formatTick(String(label), hourly)}</p>
                  {rows.map((row) => {
                    const value = payload.find((item) => item.dataKey === row.campaign.id)?.value;
                    return (
                      <p key={row.campaign.id} className="tooltip-row">
                        <Swatch slot={slots.get(row.campaign.id)} />
                        <span>{row.campaign.title}</span>
                        <strong>{formatNumber(Number(value ?? 0))}</strong>
                      </p>
                    );
                  })}
                </div>
              ) : null
            }
          />
          {rows.map((row) => (
            <Line
              key={row.campaign.id}
              type="monotone"
              dataKey={row.campaign.id}
              name={row.campaign.title}
              stroke={colour(slots.get(row.campaign.id))}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
              label={({
                x,
                y,
                index,
              }: {
                x?: number | string;
                y?: number | string;
                index?: number;
              }) =>
                index === last && x !== undefined && y !== undefined ? (
                  <text
                    x={Number(x) + 8}
                    y={Number(y) + (labelShift.get(row.campaign.id) ?? 0)}
                    dy={4}
                    fontSize={12}
                    fill="var(--ink-2)"
                  >
                    {row.campaign.title.length > 14
                      ? `${row.campaign.title.slice(0, 13)}…`
                      : row.campaign.title}
                  </text>
                ) : (
                  <g />
                )
              }
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <ul className="legend">
        {rows.map((row) => (
          <li key={row.campaign.id}>
            <Swatch slot={slots.get(row.campaign.id)} /> {row.campaign.title}
          </li>
        ))}
      </ul>
    </figure>
  );
};

export const ComparePage = () => {
  const [rangeId, setRangeId] = useState('7d');
  const [selected, setSelected] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [listError, setListError] = useState('');
  const slots = useSlots(selected);

  useEffect(() => {
    api
      .analytics(rangeFor('30d'))
      .then((list) => {
        setCampaigns(list);
        // Start with the two busiest campaigns, so the page shows something useful.
        setSelected(
          [...list]
            .sort((a, b) => b.lifetimeImpressions - a.lifetimeImpressions)
            .slice(0, 2)
            .map(({ id }) => id),
        );
      })
      .catch((error: Error) => setListError(error.message));
  }, []);

  const key = `${rangeId}:${selected.join(',')}`;
  const { data, error } = useLiveData(
    () => (selected.length >= 2 ? api.compare(selected, rangeFor(rangeId)) : Promise.resolve([])),
    key,
  );

  const toggle = (id: string): void =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, MAX),
    );

  const rows = (data ?? []).filter((row) => selected.includes(row.campaign.id));

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('Compare campaigns')}</h1>
          <p className="muted">{t('Choose two to four campaigns to see them side by side.')}</p>
        </div>
        <div className="toolbar">
          <RangePicker value={rangeId} onChange={setRangeId} />
        </div>
      </header>

      <ErrorNote message={listError || error} />

      <section className="card">
        <fieldset className="checks compare-picker">
          <legend>
            {t('Campaigns ({length} of up to {MAX})', { length: selected.length, MAX })}
          </legend>
          {campaigns === null && !listError && <p className="empty">{t('Loading…')}</p>}
          {campaigns?.length === 0 && <p className="empty">{t('No campaigns yet.')}</p>}
          {campaigns?.map((campaign) => {
            const checked = selected.includes(campaign.id);
            return (
              <label key={campaign.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= MAX}
                  onChange={() => toggle(campaign.id)}
                />
                {checked && <Swatch slot={slots.get(campaign.id)} />}
                {campaign.title}
              </label>
            );
          })}
        </fieldset>
      </section>

      {selected.length < 2 ? (
        <p className="empty card">{t('Choose at least two campaigns.')}</p>
      ) : rows.length > 0 ? (
        <>
          <section className="card">
            <CompareChart rows={rows} slots={slots} />
          </section>
          <section className="card">
            <h2>{t('Side by side')}</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('Measure')}</th>
                    {rows.map((row) => (
                      <th key={row.campaign.id} scope="col" className="num">
                        <Swatch slot={slots.get(row.campaign.id)} />{' '}
                        <a href={`#/campaigns/${row.campaign.id}`}>{row.campaign.title}</a>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">{t('Pacing')}</th>
                    {rows.map((row) => (
                      <td key={row.campaign.id} className="num">
                        <PacingBadge pacing={row.campaign.pacing} />
                      </td>
                    ))}
                  </tr>
                  {METRICS.map(([label, value, format]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      {rows.map((row) => (
                        <td key={row.campaign.id} className="num">
                          {format(value(row))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        !error && <p className="empty">{t('Loading…')}</p>
      )}
    </>
  );
};
