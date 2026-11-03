import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type Campaign,
  type CampaignInput,
  type Forecast,
  type Segment,
} from './api';
import { COUNTRY_LABELS, DEVICE_LABELS, SLOT_LABELS, formatNumber } from './format';

const DAYPARTS: Array<[string, string, number[]]> = [
  ['night', 'Night (00-05)', [0, 1, 2, 3, 4, 5]],
  ['morning', 'Morning (06-11)', [6, 7, 8, 9, 10, 11]],
  ['afternoon', 'Afternoon (12-17)', [12, 13, 14, 15, 16, 17]],
  ['evening', 'Evening (18-23)', [18, 19, 20, 21, 22, 23]],
];

const WEEKDAYS: Array<[string, string]> = [
  ['1', 'Mon'],
  ['2', 'Tue'],
  ['3', 'Wed'],
  ['4', 'Thu'],
  ['5', 'Fri'],
  ['6', 'Sat'],
  ['0', 'Sun'],
];

const WARNINGS: Record<string, string> = {
  NO_HISTORY: 'There is no traffic history for this targeting yet.',
  BID_BELOW_FLOOR: 'This bid is under the auction minimum, so the campaign won’t deliver.',
  NOT_ENOUGH_INVENTORY: 'There may not be enough matching traffic to reach the goal.',
  BUDGET_BELOW_GOAL: 'This budget buys fewer impressions than the goal.',
  LIMITS_BELOW_GOAL: 'Your daily limits or frequency cap are below what the goal needs.',
  AUDIENCE_NEEDS_CONSENT: 'Audiences only include viewers who consented.',
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const ForecastPanel = ({ forecast }: { forecast: Forecast | null }) => (
  <section className="forecast" aria-live="polite">
    <h3>Forecast</h3>
    {forecast ? (
      <>
        <dl>
          <div>
            <dt>Impressions</dt>
            <dd>
              {compact.format(forecast.lowImpressions)} to{' '}
              {compact.format(forecast.highImpressions)}
            </dd>
          </div>
          <div>
            <dt>Reach</dt>
            <dd>{compact.format(forecast.expectedReach)} viewers</dd>
          </div>
          <div>
            <dt>Average views</dt>
            <dd>{forecast.averageFrequency}</dd>
          </div>
          <div>
            <dt>Of your goal</dt>
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
      <p className="hint">Calculating…</p>
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
  onClose,
  onSaved,
}: {
  campaign?: Campaign;
  onClose: () => void;
  onSaved: (id: string) => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const today = new Date();
  const [title, setTitle] = useState(campaign?.title ?? '');
  const [advertiser, setAdvertiser] = useState(campaign?.advertiser ?? '');
  const [budget, setBudget] = useState(campaign ? String(campaign.budgetCents / 100) : '10000');
  const [cpm, setCpm] = useState(campaign ? String(campaign.cpmCents / 100) : '20');
  const [startsAt, setStartsAt] = useState(toDateInput(campaign?.startsAt ?? today));
  const [endsAt, setEndsAt] = useState(
    toDateInput(campaign?.endsAt ?? new Date(today.getTime() + 30 * 86_400_000)),
  );
  const [countries, setCountries] = useState(campaign?.targetCountries ?? []);
  const [genres, setGenres] = useState(campaign?.targetGenres ?? []);
  const [devices, setDevices] = useState(campaign?.targetDevices ?? []);
  const [slots, setSlots] = useState(campaign?.targetSlots ?? []);
  const [segmentIds, setSegmentIds] = useState(campaign?.targetSegmentIds ?? []);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [deliveryType, setDeliveryType] = useState(campaign?.deliveryType ?? 'GUARANTEED');
  const [pacingMode, setPacingMode] = useState(campaign?.pacingMode ?? 'EVEN');
  const [dailyBudget, setDailyBudget] = useState(
    campaign?.dailyBudgetCents ? String(campaign.dailyBudgetCents / 100) : '',
  );
  const [dailyTarget, setDailyTarget] = useState(String(campaign?.dailyImpressionTarget ?? ''));
  const [frequencyCap, setFrequencyCap] = useState(String(campaign?.frequencyCapPerDay ?? ''));
  const [category, setCategory] = useState(campaign?.competitiveCategory ?? '');
  const [dayparts, setDayparts] = useState(
    DAYPARTS.filter(([, , hours]) =>
      hours.every((hour) => campaign?.activeHours.includes(hour)),
    ).map(([id]) => id),
  );
  const [weekdays, setWeekdays] = useState((campaign?.activeDays ?? []).map(String));
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
        <h2 id="form-title">{campaign ? 'Edit campaign' : 'New campaign'}</h2>

        <div className="fields">
          <label className="wide">
            Campaign name
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
            />
          </label>
          <label className="wide">
            Advertiser
            <input
              value={advertiser}
              onChange={(e) => setAdvertiser(e.target.value)}
              required
              minLength={2}
            />
          </label>
          <label>
            Budget (€)
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
            {deliveryType === 'AUCTION' ? 'Highest bid' : 'CPM'} (€ per 1,000 impressions)
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
            Starts
            <input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </label>
          <label>
            Ends
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
            How it's bought
            <select
              value={deliveryType}
              onChange={(e) => setDeliveryType(e.target.value as CampaignInput['deliveryType'])}
            >
              <option value="GUARANTEED">Guaranteed delivery</option>
              <option value="AUCTION">Auction: bid for spare traffic</option>
            </select>
          </label>
          <label>
            Pacing
            <select
              value={pacingMode}
              onChange={(e) => setPacingMode(e.target.value as CampaignInput['pacingMode'])}
            >
              <option value="EVEN">Even across the dates</option>
              <option value="ASAP">As fast as possible</option>
              <option value="CUSTOM">Daily target</option>
            </select>
          </label>
          {pacingMode === 'CUSTOM' && (
            <label>
              Impressions per day
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
            Daily budget (€, optional)
            <input
              type="number"
              min="1"
              value={dailyBudget}
              onChange={(e) => setDailyBudget(e.target.value)}
            />
          </label>
          <label>
            Most views per viewer per day (optional)
            <input
              type="number"
              min="1"
              max="100"
              value={frequencyCap}
              onChange={(e) => setFrequencyCap(e.target.value)}
            />
          </label>
          <label>
            Competitive category (optional)
            <input
              value={category}
              placeholder="For example, Automotive"
              onChange={(e) => setCategory(e.target.value)}
            />
          </label>
        </div>

        <p className="hint">
          This budget buys about <strong>{formatNumber(impressionGoal)}</strong> impressions. Leave
          a targeting group empty to run everywhere.
        </p>

        <CheckGroup
          legend="Ad slots"
          options={Object.entries(SLOT_LABELS)}
          selected={slots}
          onChange={setSlots}
        />
        <CheckGroup
          legend="Countries"
          options={Object.entries(COUNTRY_LABELS)}
          selected={countries}
          onChange={setCountries}
        />
        <CheckGroup
          legend="Devices"
          options={Object.entries(DEVICE_LABELS)}
          selected={devices}
          onChange={setDevices}
        />
        <CheckGroup
          legend="Times of day"
          options={DAYPARTS.map(([id, label]) => [id, label])}
          selected={dayparts}
          onChange={setDayparts}
        />
        <CheckGroup legend="Days" options={WEEKDAYS} selected={weekdays} onChange={setWeekdays} />
        {segments.length > 0 && (
          <CheckGroup
            legend="Audiences"
            options={segments.map(({ id, name }) => [id, name])}
            selected={segmentIds}
            onChange={setSegmentIds}
          />
        )}
        <CheckGroup
          legend="Show genres"
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
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </form>
    </dialog>
  );
};

export default CampaignForm;
