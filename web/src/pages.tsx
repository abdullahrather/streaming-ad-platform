import { useState } from 'react';
import { OpenAlerts } from './alerts';
import { api, type Campaign, type User } from './api';
import CampaignForm from './CampaignForm';
import { CampaignAds } from './creatives';
import {
  Breakdown,
  DropOffBySegment,
  FilteredTraffic,
  ForecastComparison,
  Kpis,
  PacingBadge,
  Progress,
  RangePicker,
  StatusBadge,
  Trends,
  ViewerDropOff,
  countChange,
} from './components';
import {
  COUNTRY_LABELS,
  DEVICE_LABELS,
  SLOT_LABELS,
  formatCompact,
  formatCpm,
  formatDate,
  formatEuros,
  formatNumber,
  formatPercent,
} from './format';
import { previousLabel, rangeFor, useLiveData } from './hooks';
import { ErrorNote } from './ui';

const CampaignTable = ({ campaigns, isAdmin }: { campaigns: Campaign[]; isAdmin: boolean }) => (
  <section className="card">
    <h2>Campaigns</h2>
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th scope="col">Status</th>
            <th scope="col">Pacing</th>
            <th scope="col">Delivered</th>
            <th scope="col" className="num">
              Impressions
            </th>
            <th scope="col" className="num">
              CTR
            </th>
            <th scope="col" className="num">
              Spent / budget
            </th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <tr key={campaign.id}>
              <td>
                <a href={`#/campaigns/${campaign.id}`}>{campaign.title}</a>
                <div className="muted small">
                  {campaign.advertiser}
                  {isAdmin ? ` · ${campaign.ownerEmail}` : ''}
                </div>
              </td>
              <td>
                <StatusBadge status={campaign.status} />
              </td>
              <td>
                <PacingBadge pacing={campaign.pacing} />
              </td>
              <td className="delivery">
                <Progress label={`${campaign.title} delivery`} rate={campaign.deliveryRate} />
                <span className="muted small">{formatPercent(campaign.deliveryRate, 0)}</span>
              </td>
              <td className="num">{formatCompact(campaign.impressions)}</td>
              <td className="num">{formatPercent(campaign.ctr, 2)}</td>
              <td className="num">
                {formatEuros(campaign.lifetimeSpendCents)} / {formatEuros(campaign.budgetCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

const canEdit = (user: User): boolean =>
  user.role === 'ADMIN' || user.organisationRole === 'OWNER' || user.organisationRole === 'MANAGER';

export const Overview = ({ user, onOpen }: { user: User; onOpen: (id: string) => void }) => {
  const [rangeId, setRangeId] = useState('7d');
  const [creating, setCreating] = useState(false);

  const { data, error, refresh } = useLiveData(async () => {
    const range = rangeFor(rangeId);
    const [campaigns, points, summary] = await Promise.all([
      api.analytics(range),
      api.timeseries(range),
      api.summary(range),
    ]);
    return { campaigns, points, summary };
  }, rangeId);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Overview</h1>
          <p className="muted live">
            <span className="live-dot" aria-hidden="true" /> Updates every 5 seconds
          </p>
        </div>
        <div className="toolbar">
          <RangePicker value={rangeId} onChange={setRangeId} />
          {canEdit(user) && (
            <button type="button" className="button primary" onClick={() => setCreating(true)}>
              New campaign
            </button>
          )}
        </div>
      </header>

      <ErrorNote message={error} />

      {data ? (
        <>
          <OpenAlerts />
          <Kpis
            totals={data.summary.current}
            spendCents={data.summary.current.spendCents}
            previous={data.summary.previous}
            period={previousLabel(rangeId)}
          />
          <Trends points={data.points} />
          {data.campaigns.length > 0 ? (
            <CampaignTable campaigns={data.campaigns} isAdmin={user.role === 'ADMIN'} />
          ) : (
            <p className="empty card">
              {user.organisationId || user.role === 'GUEST'
                ? 'No campaigns yet.'
                : 'You are not in an organisation yet.'}
            </p>
          )}
        </>
      ) : (
        !error && <p className="empty">Loading…</p>
      )}

      {creating && (
        <CampaignForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            refresh();
            onOpen(id);
          }}
        />
      )}
    </>
  );
};

const list = (values: string[], labels?: Record<string, string>): string =>
  values.length > 0 ? values.map((value) => labels?.[value] ?? value).join(', ') : 'All';

const Facts = ({ campaign }: { campaign: Campaign }) => {
  const facts = [
    ['Flight', `${formatDate(campaign.startsAt)} – ${formatDate(campaign.endsAt)}`],
    ['CPM', formatCpm(campaign.cpmCents)],
    ['Ad slots', list(campaign.targetSlots, SLOT_LABELS)],
    ['Countries', list(campaign.targetCountries, COUNTRY_LABELS)],
    ['Devices', list(campaign.targetDevices, DEVICE_LABELS)],
    ['Show genres', list(campaign.targetGenres)],
  ];
  return (
    <section className="card">
      <h2>Setup</h2>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

const Delivery = ({ campaign }: { campaign: Campaign }) => (
  <section className="card">
    <h2>Delivery</h2>
    <div className="goal">
      <div className="bar-label">
        <span>Impressions</span>
        <span className="bar-value">
          {formatNumber(campaign.lifetimeImpressions)} of {formatNumber(campaign.impressionGoal)}
        </span>
      </div>
      <Progress label="Impression goal" rate={campaign.deliveryRate} />
    </div>
    <div className="goal">
      <div className="bar-label">
        <span>Budget</span>
        <span className="bar-value">
          {formatEuros(campaign.lifetimeSpendCents)} of {formatEuros(campaign.budgetCents)}
        </span>
      </div>
      <Progress label="Budget used" rate={campaign.budgetUsedRate} />
    </div>
  </section>
);

export const CampaignPage = ({
  id,
  user,
  onBack,
}: {
  id: string;
  user: User;
  onBack: () => void;
}) => {
  const [rangeId, setRangeId] = useState('7d');
  const [editing, setEditing] = useState(false);
  const { data, error, refresh } = useLiveData(
    () => api.campaign(id, rangeFor(rangeId)),
    `${id}-${rangeId}`,
  );

  const campaign = data?.campaign;

  const setStatus = (status: 'ACTIVE' | 'PAUSED') => {
    api.update(id, { status }).then(refresh).catch(refresh);
  };

  const remove = () => {
    if (!campaign || !window.confirm(`Delete “${campaign.title}” and all its data?`)) return;
    api.remove(id).then(onBack).catch(refresh);
  };

  return (
    <>
      <a className="back" href="#/">
        ← Overview
      </a>
      <ErrorNote message={error} />
      {campaign && data ? (
        <>
          <header className="page-header">
            <div>
              <h1>{campaign.title}</h1>
              <p className="muted">{campaign.advertiser}</p>
              <p className="badges">
                <StatusBadge status={campaign.status} />
                <PacingBadge pacing={campaign.pacing} />
              </p>
            </div>
            <div className="toolbar">
              <RangePicker value={rangeId} onChange={setRangeId} />
              {canEdit(user) && (
                <>
                  {campaign.status !== 'COMPLETED' && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => setStatus(campaign.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
                    >
                      {campaign.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  <button type="button" className="button" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button type="button" className="button danger" onClick={remove}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </header>

          <OpenAlerts campaignId={campaign.id} />
          <Kpis
            totals={campaign}
            spendCents={campaign.spendCents}
            previous={data.previous}
            period={previousLabel(rangeId)}
            extra={[
              {
                label: 'Reach',
                value: formatCompact(data.reach),
                change: countChange(data.reach, data.previous.reach),
              },
              {
                label: 'Average frequency',
                value: data.averageFrequency ? `${data.averageFrequency.toFixed(1)}×` : '–',
                // Seeing an ad more often isn't good or bad in itself, so it isn't coloured.
                change: countChange(data.averageFrequency, data.previous.averageFrequency, true),
              },
            ]}
          />
          <p className="muted small kpi-note">
            Reach counts each viewer once over the days in this period. Average frequency is
            impressions per viewer. Both are estimates, usually within 1 to 2%.
          </p>
          <div className="columns">
            <Delivery campaign={campaign} />
            <Facts campaign={campaign} />
          </div>
          <ForecastComparison campaign={campaign} reach={data.lifetimeReach} />
          <CampaignAds campaignId={campaign.id} canEdit={canEdit(user)} />
          <Trends points={data.timeseries} />
          <ViewerDropOff totals={campaign} />
          <DropOffBySegment
            groups={[
              { id: 'slot', label: 'Ad slot', rows: data.breakdown.slot, labels: SLOT_LABELS },
              { id: 'device', label: 'Device', rows: data.breakdown.device, labels: DEVICE_LABELS },
              { id: 'show', label: 'Show', rows: data.breakdown.show },
            ]}
          />
          <FilteredTraffic rows={data.filtered} />
          <div className="columns">
            <Breakdown title="By ad slot" rows={data.breakdown.slot} labels={SLOT_LABELS} />
            <Breakdown title="By device" rows={data.breakdown.device} labels={DEVICE_LABELS} />
            <Breakdown title="By country" rows={data.breakdown.country} labels={COUNTRY_LABELS} />
            <Breakdown title="By show" rows={data.breakdown.show} />
          </div>

          {editing && (
            <CampaignForm
              campaign={campaign}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                refresh();
              }}
            />
          )}
        </>
      ) : (
        !error && <p className="empty">Loading…</p>
      )}
    </>
  );
};
