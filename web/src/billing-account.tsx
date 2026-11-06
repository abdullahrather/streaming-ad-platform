import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type BillingDetails,
  type BillingDetailsInput,
  type BillingOverview,
  type PlanLimit,
} from './api';
import { Progress } from './components';
import { formatMoney, formatNumber } from './format';
import { ErrorNote, firstError } from './ui';

const errorText = (reason: unknown): string =>
  reason instanceof ApiError ? firstError(reason) : String(reason);

export const CURRENCIES = ['EUR', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'USD'];

/** EU countries, then a few common ones outside the EU. */
const COUNTRIES: Array<[string, string]> = [
  ['AT', 'Austria'],
  ['BE', 'Belgium'],
  ['BG', 'Bulgaria'],
  ['HR', 'Croatia'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['EE', 'Estonia'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GR', 'Greece'],
  ['HU', 'Hungary'],
  ['IE', 'Ireland'],
  ['IT', 'Italy'],
  ['LV', 'Latvia'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MT', 'Malta'],
  ['NL', 'Netherlands'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['RO', 'Romania'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['ES', 'Spain'],
  ['SE', 'Sweden'],
  ['NO', 'Norway'],
  ['CH', 'Switzerland'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
];

const PLAN_NAMES = { STARTER: 'Starter', GROWTH: 'Growth', ENTERPRISE: 'Enterprise' };
const LIMIT_LABELS: Record<PlanLimit, string> = {
  runningCampaigns: 'Running campaigns',
  members: 'Team members and open invitations',
  scheduledReports: 'Scheduled reports',
};

/** Reads ?checkout=… from the address after Stripe sends the payer back. */
const checkoutFromAddress = (): string =>
  new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('checkout') ?? '';

/** When the payer comes back from Stripe, asks the server to check and credit the payment. */
export const CheckoutReturn = ({ onCredited }: { onCredited: () => void }) => {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const checked = useRef(false);

  useEffect(() => {
    const sessionId = checkoutFromAddress();
    if (!sessionId || checked.current) return;
    checked.current = true;
    window.history.replaceState(null, '', '#/billing');
    api
      .confirmCheckout(sessionId)
      .then(({ paid, entry }) => {
        setMessage(
          paid && entry
            ? `Payment received: ${formatMoney(entry.amountCents)} added to your balance.`
            : 'Stripe has not confirmed the payment yet. It will appear here once it does.',
        );
        if (paid) onCredited();
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [onCredited]);

  if (!message && !error) return null;
  return (
    <div aria-live="polite">
      {message && <p className="notice">{message}</p>}
      <ErrorNote message={error} />
    </div>
  );
};

/** Adding credit: by card through Stripe when it's set up, otherwise through the platform team. */
export const AddCredit = ({ data, isOwner }: { data: BillingOverview; isOwner: boolean }) => {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currency = data.details.currency;

  const pay = (event: FormEvent): void => {
    event.preventDefault();
    setError('');
    setBusy(true);
    api
      .checkout(Math.round(Number(amount.replace(',', '.')) * 100))
      .then(({ url }) => window.location.assign(url))
      .catch((reason: unknown) => {
        setError(errorText(reason));
        setBusy(false);
      });
  };

  return (
    <section className="card">
      <h2>Add credit</h2>
      {!data.cardPayments ? (
        <p className="muted">
          Card payments aren't set up on this platform. Ask the platform team to add credit, for
          example when your bank transfer arrives.
        </p>
      ) : !isOwner ? (
        <p className="muted">Owners can add credit by card.</p>
      ) : (
        <form className="credit-form" onSubmit={pay} aria-label="Pay by card">
          <label>
            Amount ({currency})
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1000"
              required
            />
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Opening Stripe…' : 'Pay by card'}
          </button>
          <p className="muted small">
            You pay on Stripe's secure page.
            {data.rate
              ? ` It's added to your balance in euros at today's rate: 1 EUR = ${data.rate.rate.toFixed(4)} ${currency}.`
              : ''}
          </p>
        </form>
      )}
      <ErrorNote message={error} />
    </section>
  );
};

export const PlanUsage = ({ data }: { data: BillingOverview }) => (
  <section className="card">
    <h2>Plan: {PLAN_NAMES[data.plan]}</h2>
    <div className="stack">
      {(Object.keys(LIMIT_LABELS) as PlanLimit[]).map((limit) => {
        const max = data.limits[limit];
        const used = data.usage[limit];
        return (
          <div key={limit} className="goal">
            <div className="bar-label">
              <span>{LIMIT_LABELS[limit]}</span>
              <span className="bar-value">
                {max === null
                  ? `${formatNumber(used)}, no limit`
                  : `${formatNumber(used)} of ${formatNumber(max)}`}
              </span>
            </div>
            {max !== null && (
              <Progress label={LIMIT_LABELS[limit]} rate={max > 0 ? used / max : 1} />
            )}
          </div>
        );
      })}
    </div>
    <p className="muted small">A platform admin changes the plan.</p>
  </section>
);

const VAT_CHECK: Record<NonNullable<BillingDetails['vatCheck']>, string> = {
  valid: 'The EU confirmed this VAT ID.',
  invalid: 'The EU does not know this VAT ID, so German VAT is charged.',
  unavailable:
    "The EU's VAT check isn't answering right now, so German VAT is charged. Save again later.",
  'not needed': '',
};

/** The details printed on invoices, which decide the VAT. Owners edit them. */
export const BillingDetailsForm = ({
  details,
  isOwner,
  onSaved,
}: {
  details: BillingDetails;
  isOwner: boolean;
  onSaved: () => void;
}) => {
  const [form, setForm] = useState<BillingDetailsInput>(details);
  const [result, setResult] = useState<BillingDetails | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = result ?? details;

  const field = (key: keyof BillingDetailsInput, label: string, extra = {}) => (
    <label>
      {label}
      <input
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        disabled={!isOwner}
        {...extra}
      />
    </label>
  );

  const save = (event: FormEvent): void => {
    event.preventDefault();
    setError('');
    setBusy(true);
    api
      .saveBillingDetails(form)
      .then((saved) => {
        setResult(saved);
        setForm(saved);
        onSaved();
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Billing details</h2>
      <p className="muted small">
        Printed on your invoices. Your country and VAT ID decide the VAT.
        {isOwner ? '' : ' Owners can change them.'}
      </p>
      <form className="details-form" onSubmit={save}>
        {field('billingName', 'Company name')}
        {field('addressLine1', 'Address')}
        {field('addressLine2', 'Address, second line')}
        {field('postalCode', 'Postcode')}
        {field('city', 'City')}
        <label>
          Country
          <select
            value={form.country}
            onChange={(event) =>
              setForm((current) => ({ ...current, country: event.target.value }))
            }
            disabled={!isOwner}
          >
            <option value="">Choose a country</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {field('vatId', 'VAT ID', { placeholder: 'For example FR12345678901' })}
        <label>
          Pay and be invoiced in
          <select
            value={form.currency}
            onChange={(event) =>
              setForm((current) => ({ ...current, currency: event.target.value }))
            }
            disabled={!isOwner}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        {isOwner && (
          <div className="actions">
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save details'}
            </button>
          </div>
        )}
      </form>
      <div aria-live="polite">
        <p className="small">
          <span className="badge badge-neutral">VAT {shown.vat.rateBp / 100}%</span>{' '}
          {shown.vat.note || 'German VAT applies.'}
        </p>
        {result?.vatCheck && VAT_CHECK[result.vatCheck] && (
          <p className="muted small">{VAT_CHECK[result.vatCheck]}</p>
        )}
      </div>
      <ErrorNote message={error} />
    </section>
  );
};
