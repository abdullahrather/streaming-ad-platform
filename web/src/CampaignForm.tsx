import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type Campaign,
  type CampaignDraft,
  type CampaignInput,
  type Forecast,
  type Segment,
} from './api';
import { COUNTRY_LABELS, DEVICE_LABELS, SLOT_LABELS, formatNumber } from './format';
import { locale, t } from './i18n';

const DAYPARTS: Array<[string, string, number[]]> = [
  ['night', t('Night (00-05)'), [0, 1, 2, 3, 4, 5]],
  ['morning', t('Morning (06-11)'), [6, 7, 8, 9, 10, 11]],
  ['afternoon', t('Afternoon (12-17)'), [12, 13, 14, 15, 16, 17]],
  ['evening', t('Evening (18-23)'), [18, 19, 20, 21, 22, 23]],
];

const WEEKDAYS: Array<[string, string]> = [
  ['1', t('Mon')],
  ['2', t('Tue')],
  ['3', t('Wed')],
  ['4', t('Thu')],
  ['5', t('Fri')],
  ['6', t('Sat')],
  ['0', t('Sun')],
];

const WARNINGS: Record<string, string> = {
  NO_HISTORY: t('There is no traffic history for this targeting yet.'),
  BID_BELOW_FLOOR: t('This bid is under the auction minimum, so the campaign won’t deliver.'),
  NOT_ENOUGH_INVENTORY: t('There may not be enough matching traffic to reach the goal.'),
  BUDGET_BELOW_GOAL: t('This budget buys fewer impressions than the goal.'),
  LIMITS_BELOW_GOAL: t('Your daily limits or frequency cap are below what the goal needs.'),
  AUDIENCE_NEEDS_CONSENT: t('Audiences only include viewers who consented.'),
};

const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

const ForecastPanel = ({ forecast }: { forecast: Forecast | null }) => (
  <section className="forecast" aria-live="polite">
    <h3>{t('Forecast')}</h3>
    {forecast ? (
      <>
        <dl>
          <div>
            <dt>{t('Impressions')}</dt>
            <dd>
              {t('{value} to {value2}', {
                value: compact.format(forecast.lowImpressions),
                value2: compact.format(forecast.highImpressions),
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Reach')}</dt>
            <dd>{t('{value} viewers', { value: compact.format(forecast.expectedReach) })}</dd>
          </div>
          <div>
            <dt>{t('Average views')}</dt>
            <dd>{forecast.averageFrequency}</dd>
          </div>
          <div>
            <dt>{t('Of your goal')}</dt>
            <dd>{Math.round(forecast.goalDeliveryRate * 100)}%</dd>
          </div>
        </dl>
        {forecast.warnings.map((warning) => (
          <p key={warning} className="hint">
            {WARNINGS[warning] ?? warning}
          </p>
        ))}
      </>
    ) : (
      <p className="hint">{t('Calculating…')}</p>
    )}
  </section>
);

const toDateInput = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

const CheckGroup = ({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: Array<[string, string]>;
  selected: string[];
  onChange: (values: string[]) => void;
}) => (
  <fieldset className="checks">
    <legend>{legend}</legend>
    {options.map(([value, label]) => (
      <label key={value}>
        <input
          type="checkbox"
          checked={selected.includes(value)}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? [...selected, value]
                : selected.filter((item) => item !== value),
            )
          }
        />
        {label}
      </label>
    ))}
  </fieldset>
);

const CampaignForm = ({
  campaign,
  draft,
  onClose,
  onSaved,
}: {
  campaign?: Campaign;
  /** Starting values from the assistant, saved as a new campaign. */
  draft?: CampaignDraft;
  onClose: () => void;
  onSaved: (id: string) => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const today = new Date();
  const initial: Partial<Omit<CampaignInput, 'status'>> | undefined = campaign ?? draft?.input;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [advertiser, setAdvertiser] = useState(initial?.advertiser ?? '');
  const [budget, setBudget] = useState(
    initial?.budgetCents ? String(initial.budgetCents / 100) : '10000',
  );
  const [cpm, setCpm] = useState(initial?.cpmCents ? String(initial.cpmCents / 100) : '20');
  const [startsAt, setStartsAt] = useState(toDateInput(initial?.startsAt ?? today));
  const [endsAt, setEndsAt] = useState(
    toDateInput(initial?.endsAt ?? new Date(today.getTime() + 30 * 86_400_000)),
  );
  const [countries, setCountries] = useState(initial?.targetCountries ?? []);
  const [genres, setGenres] = useState(initial?.targetGenres ?? []);
  const [devices, setDevices] = useState(initial?.targetDevices ?? []);
  const [slots, setSlots] = useState(initial?.targetSlots ?? []);
  const [segmentIds, setSegmentIds] = useState(initial?.targetSegmentIds ?? []);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [deliveryType, setDeliveryType] = useState(initial?.deliveryType ?? 'GUARANTEED');
  const [pacingMode, setPacingMode] = useState(initial?.pacingMode ?? 'EVEN');
  const [dailyBudget, setDailyBudget] = useState(
    initial?.dailyBudgetCents ? String(initial.dailyBudgetCents / 100) : '',
  );
  const [dailyTarget, setDailyTarget] = useState(String(initial?.dailyImpressionTarget ?? ''));
  const [frequencyCap, setFrequencyCap] = useState(String(initial?.frequencyCapPerDay ?? ''));
  const [category, setCategory] = useState(initial?.competitiveCategory ?? '');
  const [dayparts, setDayparts] = useState(
    DAYPARTS.filter(([, , hours]) =>
      hours.every((hour) => initial?.activeHours?.includes(hour)),
    ).map(([id]) => id),
  );
  const [weekdays, setWeekdays] = useState((initial?.activeDays ?? []).map(String));
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    api
      .shows()
      .then((shows) => setAllGenres([...new Set(shows.map((show) => show.genre))].sort()))
      .catch(() => setAllGenres([]));
    api
      .segments()
      .then(setSegments)
      .catch(() => setSegments([]));
  }, []);

  const budgetCents = Math.round(Number(budget) * 100);
  const cpmCents = Math.round(Number(cpm) * 100);
  const impressionGoal = cpmCents > 0 ? Math.floor((budgetCents / cpmCents) * 1000) : 0;

  const input: CampaignInput = {
    title,
    advertiser,
    budgetCents,
    cpmCents,
    impressionGoal,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    targetCountries: countries,
    targetGenres: genres,
    targetDevices: devices,
    targetSlots: slots,
    targetSegmentIds: segmentIds,
    deliveryType,
    pacingMode,
    dailyBudgetCents: dailyBudget ? Math.round(Number(dailyBudget) * 100) : null,
    dailyImpressionTarget: pacingMode === 'CUSTOM' && dailyTarget ? Number(dailyTarget) : null,
    frequencyCapPerDay: frequencyCap ? Number(frequencyCap) : null,
    activeHours: DAYPARTS.filter(([id]) => dayparts.includes(id)).flatMap(([, , hours]) => hours),
    activeDays: weekdays.map(Number),
    competitiveCategory: category,
  };

  // The name and advertiser don't change a forecast, so they don't trigger one.
  const forecastKey = JSON.stringify({ ...input, title: '', advertiser: '' });

  useEffect(() => {
    if (impressionGoal <= 0) return undefined;

    const timer = window.setTimeout(() => {
      api
        .forecast({ ...input, title: 'Forecast', advertiser: 'Forecast' })
        .then(setForecast)
        .catch(() => setForecast(null));
    }, 350);
    return () => window.clearTimeout(timer);
    // The key already covers every field the forecast uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      const saved = campaign ? await api.update(campaign.id, input) : await api.create(input);
      onSaved(saved.id);
    } catch (reason) {
      const fields = reason instanceof ApiError ? Object.values(reason.fields ?? {}).flat() : [];
      setError(fields[0] ?? (reason as Error).message);
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="form-title">
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="form-title">{campaign ? t('Edit campaign') : t('New campaign')}</h2>
        {draft && (
          <div className="notice">
            <p>
              <strong>{t('Drafted by the AI assistant from your brief.')}</strong>{' '}
              {t('Check every field before you create it.')}
            </p>
            {draft.assumptions.length > 0 && (
              <ul className="small">
                {draft.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="fields">
          <label className="wide">
            {t('Campaign name')}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
            />
          </label>
          <label className="wide">
            {t('Advertiser')}
            <input
              value={advertiser}
              onChange={(e) => setAdvertiser(e.target.value)}
              required
              minLength={2}
            />
          </label>
          <label>
            {t('Budget (€)')}
            <input
              type="number"
              min="1"
              step="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              required
            />
          </label>
          <label>
            {deliveryType === 'AUCTION'
              ? t('Highest bid (€ per 1,000 impressions)')
              : t('CPM (€ per 1,000 impressions)')}
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={cpm}
              onChange={(e) => setCpm(e.target.value)}
              required
            />
          </label>
          <label>
            {t('Starts')}
            <input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </label>
          <label>
            {t('Ends')}
            <input
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </label>
        </div>

        <div className="fields">
          <label>
            {t("How it's bought")}
            <select
              value={deliveryType}
              onChange={(e) => setDeliveryType(e.target.value as CampaignInput['deliveryType'])}
            >
              <option value="GUARANTEED">{t('Guaranteed delivery')}</option>
              <option value="AUCTION">{t('Auction: bid for spare traffic')}</option>
            </select>
          </label>
          <label>
            {t('Pacing')}
            <select
              value={pacingMode}
              onChange={(e) => setPacingMode(e.target.value as CampaignInput['pacingMode'])}
            >
              <option value="EVEN">{t('Even across the dates')}</option>
              <option value="ASAP">{t('As fast as possible')}</option>
              <option value="CUSTOM">{t('Daily target')}</option>
            </select>
          </label>
          {pacingMode === 'CUSTOM' && (
            <label>
              {t('Impressions per day')}
              <input
                type="number"
                min="1"
                value={dailyTarget}
                onChange={(e) => setDailyTarget(e.target.value)}
                required
              />
            </label>
          )}
          <label>
            {t('Daily budget (€, optional)')}
            <input
              type="number"
              min="1"
              value={dailyBudget}
              onChange={(e) => setDailyBudget(e.target.value)}
            />
          </label>
          <label>
            {t('Most views per viewer per day (optional)')}
            <input
              type="number"
              min="1"
              max="100"
              value={frequencyCap}
              onChange={(e) => setFrequencyCap(e.target.value)}
            />
          </label>
          <label>
            {t('Competitive category (optional)')}
            <input
              value={category}
              placeholder={t('For example, Automotive')}
              onChange={(e) => setCategory(e.target.value)}
            />
          </label>
        </div>

        <p className="hint">
          {t('This budget buys about')} <strong>{formatNumber(impressionGoal)}</strong>{' '}
          {t('impressions. Leave a targeting group empty to run everywhere.')}
        </p>

        <CheckGroup
          legend={t('Ad slots')}
          options={Object.entries(SLOT_LABELS)}
          selected={slots}
          onChange={setSlots}
        />
        <CheckGroup
          legend={t('Countries')}
          options={Object.entries(COUNTRY_LABELS)}
          selected={countries}
          onChange={setCountries}
        />
        <CheckGroup
          legend={t('Devices')}
          options={Object.entries(DEVICE_LABELS)}
          selected={devices}
          onChange={setDevices}
        />
        <CheckGroup
          legend={t('Times of day')}
          options={DAYPARTS.map(([id, label]) => [id, label])}
          selected={dayparts}
          onChange={setDayparts}
        />
        <CheckGroup
          legend={t('Days')}
          options={WEEKDAYS}
          selected={weekdays}
          onChange={setWeekdays}
        />
        {segments.length > 0 && (
          <CheckGroup
            legend={t('Audiences')}
            options={segments.map(({ id, name }) => [id, name])}
            selected={segmentIds}
            onChange={setSegmentIds}
          />
        )}
        <CheckGroup
          legend={t('Show genres')}
          options={allGenres.map((genre) => [genre, genre])}
          selected={genres}
          onChange={setGenres}
        />

        <ForecastPanel forecast={forecast} />

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? t('Saving…') : campaign ? t('Save changes') : t('Create campaign')}
          </button>
        </div>
      </form>
    </dialog>
  );
};

export default CampaignForm;
