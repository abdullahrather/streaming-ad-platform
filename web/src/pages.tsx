import { useState } from 'react';
import { OpenAlerts } from './alerts';
import { CampaignAssistant, DeliveryCheck, DraftFromBrief, useAiStatus } from './assistant';
import { ApiError, api, type Campaign, type CampaignDraft, type User } from './api';
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
  formatDecimal,
} from './format';
import { previousLabel, rangeFor, useLiveData } from './hooks';
import { ErrorNote, firstError } from './ui';
import { t } from './i18n';

const CampaignTable = ({ campaigns, isAdmin }: { campaigns: Campaign[]; isAdmin: boolean }) => (
  <section className="card">
    <h2>{t('Campaigns')}</h2>
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('Campaign')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col">{t('Pacing')}</th>
            <th scope="col">{t('Delivered')}</th>
            <th scope="col" className="num">
              {t('Impressions')}
            </th>
            <th scope="col" className="num">
              {t('CTR')}
            </th>
            <th scope="col" className="num">
              {t('Spent / budget')}
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
                <Progress
                  label={t('{title} delivery', { title: campaign.title })}
                  rate={campaign.deliveryRate}
                />
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
  const [briefing, setBriefing] = useState(false);
  const [draft, setDraft] = useState<CampaignDraft | undefined>(undefined);
  const ai = useAiStatus();

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
          <h1>{t('Overview')}</h1>
          <p className="muted live">
            <span className="live-dot" aria-hidden="true" /> {t('Updates every 5 seconds')}
          </p>
        </div>
        <div className="toolbar">
          <RangePicker value={rangeId} onChange={setRangeId} />
          {canEdit(user) && ai?.enabled && (
            <button type="button" className="button" onClick={() => setBriefing(true)}>
              {t('Draft from a brief')}
            </button>
          )}
          {canEdit(user) && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setDraft(undefined);
                setCreating(true);
              }}
            >
              {t('New campaign')}
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
                ? t('No campaigns yet.')
                : t('You are not in an organisation yet.')}
            </p>
          )}
        </>
      ) : (
        !error && <p className="empty">{t('Loading…')}</p>
      )}

      {briefing && (
        <DraftFromBrief
          onClose={() => setBriefing(false)}
          onDraft={(drafted) => {
            setBriefing(false);
            setDraft(drafted);
            setCreating(true);
          }}
        />
      )}

      {creating && (
        <CampaignForm
          {...(draft ? { draft } : {})}
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
  values.length > 0 ? values.map((value) => labels?.[value] ?? value).join(', ') : t('All');

const Facts = ({ campaign }: { campaign: Campaign }) => {
  const facts = [
    [t('Flight'), `${formatDate(campaign.startsAt)} – ${formatDate(campaign.endsAt)}`],
    ['CPM', formatCpm(campaign.cpmCents)],
    [t('Ad slots'), list(campaign.targetSlots, SLOT_LABELS)],
    [t('Countries'), list(campaign.targetCountries, COUNTRY_LABELS)],
    [t('Devices'), list(campaign.targetDevices, DEVICE_LABELS)],
    [t('Show genres'), list(campaign.targetGenres)],
  ];
  return (
    <section className="card">
      <h2>{t('Setup')}</h2>
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
    <h2>{t('Delivery')}</h2>
    <div className="goal">
      <div className="bar-label">
        <span>{t('Impressions')}</span>
        <span className="bar-value">
          {t('{number} of {number2}', {
            number: formatNumber(campaign.lifetimeImpressions),
            number2: formatNumber(campaign.impressionGoal),
          })}
        </span>
      </div>
      <Progress label={t('Impression goal')} rate={campaign.deliveryRate} />
    </div>
    <div className="goal">
      <div className="bar-label">
        <span>{t('Budget')}</span>
        <span className="bar-value">
          {t('{euros} of {euros2}', {
            euros: formatEuros(campaign.lifetimeSpendCents),
            euros2: formatEuros(campaign.budgetCents),
          })}
        </span>
      </div>
      <Progress label={t('Budget used')} rate={campaign.budgetUsedRate} />
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

  // Shown when a change is refused, such as resuming without enough balance.
  const [actionError, setActionError] = useState('');
  const failed = (reason: unknown): void => {
    setActionError(reason instanceof ApiError ? firstError(reason) : String(reason));
    refresh();
  };

  const setStatus = (status: 'ACTIVE' | 'PAUSED') => {
    setActionError('');
    api.update(id, { status }).then(refresh).catch(failed);
  };

  const remove = () => {
    if (
      !campaign ||
      !window.confirm(t('Delete “{title}” and all its data?', { title: campaign.title }))
    )
      return;
    setActionError('');
    api.remove(id).then(onBack).catch(failed);
  };

  return (
    <>
      <a className="back" href="#/">
        {t('← Overview')}
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
                      {campaign.status === 'ACTIVE' ? t('Pause') : t('Resume')}
                    </button>
                  )}
                  <button type="button" className="button" onClick={() => setEditing(true)}>
                    {t('Edit')}
                  </button>
                  <button type="button" className="button danger" onClick={remove}>
                    {t('Delete')}
                  </button>
                </>
              )}
            </div>
          </header>

          <ErrorNote message={actionError} />
          <OpenAlerts campaignId={campaign.id} />
          <Kpis
            totals={campaign}
            spendCents={campaign.spendCents}
            previous={data.previous}
            period={previousLabel(rangeId)}
            extra={[
              {
                label: t('Reach'),
                value: formatCompact(data.reach),
                change: countChange(data.reach, data.previous.reach),
              },
              {
                label: t('Average frequency'),
                value: data.averageFrequency ? `${formatDecimal(data.averageFrequency)}×` : '–',
                // Seeing an ad more often isn't good or bad in itself, so it isn't coloured.
                change: countChange(data.averageFrequency, data.previous.averageFrequency, true),
              },
            ]}
          />
          <p className="muted small kpi-note">
            {t(
              'Reach counts each viewer once over the days in this period. Average frequency is impressions per viewer. Both are estimates, usually within 1 to 2%.',
            )}
          </p>
          <div className="columns">
            <Delivery campaign={campaign} />
            <Facts campaign={campaign} />
          </div>
          {/* Settings it depends on, so an approved change re-runs it. */}
          <DeliveryCheck
            key={JSON.stringify([
              campaign.status,
              campaign.budgetCents,
              campaign.cpmCents,
              campaign.pacingMode,
              campaign.dailyBudgetCents,
              campaign.dailyImpressionTarget,
              campaign.frequencyCapPerDay,
              campaign.activeHours,
              campaign.activeDays,
              campaign.targetCountries,
              campaign.targetDevices,
              campaign.targetSlots,
              campaign.targetGenres,
            ])}
            campaignId={campaign.id}
          />
          <CampaignAssistant campaignId={campaign.id} user={user} onApplied={refresh} />
          <ForecastComparison campaign={campaign} reach={data.lifetimeReach} />
          <CampaignAds campaignId={campaign.id} canEdit={canEdit(user)} />
          <Trends points={data.timeseries} />
          <ViewerDropOff totals={campaign} />
          <DropOffBySegment
            groups={[
              { id: 'slot', label: t('Ad slot'), rows: data.breakdown.slot, labels: SLOT_LABELS },
              {
                id: 'device',
                label: t('Device'),
                rows: data.breakdown.device,
                labels: DEVICE_LABELS,
              },
              { id: 'show', label: t('Show'), rows: data.breakdown.show },
            ]}
          />
          <FilteredTraffic rows={data.filtered} />
          <div className="columns">
            <Breakdown title={t('By ad slot')} rows={data.breakdown.slot} labels={SLOT_LABELS} />
            <Breakdown title={t('By device')} rows={data.breakdown.device} labels={DEVICE_LABELS} />
            <Breakdown
              title={t('By country')}
              rows={data.breakdown.country}
              labels={COUNTRY_LABELS}
            />
            <Breakdown title={t('By show')} rows={data.breakdown.show} />
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
        !error && <p className="empty">{t('Loading…')}</p>
      )}
    </>
  );
};
