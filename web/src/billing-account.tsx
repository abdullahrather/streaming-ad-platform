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
import { formatDecimal, formatMoney, formatNumber } from './format';
import { ErrorNote, firstError } from './ui';
import { t } from './i18n';

const errorText = (reason: unknown): string =>
  reason instanceof ApiError ? firstError(reason) : String(reason);

export const CURRENCIES = ['EUR', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'USD'];

/** EU countries, then a few common ones outside the EU. */
const COUNTRIES: Array<[string, string]> = [
  ['AT', t('Austria')],
  ['BE', t('Belgium')],
  ['BG', t('Bulgaria')],
  ['HR', t('Croatia')],
  ['CY', t('Cyprus')],
  ['CZ', t('Czechia')],
  ['DK', t('Denmark')],
  ['EE', t('Estonia')],
  ['FI', t('Finland')],
  ['FR', t('France')],
  ['DE', t('Germany')],
  ['GR', t('Greece')],
  ['HU', t('Hungary')],
  ['IE', t('Ireland')],
  ['IT', t('Italy')],
  ['LV', t('Latvia')],
  ['LT', t('Lithuania')],
  ['LU', t('Luxembourg')],
  ['MT', t('Malta')],
  ['NL', t('Netherlands')],
  ['PL', t('Poland')],
  ['PT', t('Portugal')],
  ['RO', t('Romania')],
  ['SK', t('Slovakia')],
  ['SI', t('Slovenia')],
  ['ES', t('Spain')],
  ['SE', t('Sweden')],
  ['NO', t('Norway')],
  ['CH', t('Switzerland')],
  ['GB', t('United Kingdom')],
  ['US', t('United States')],
];

const PLAN_NAMES = { STARTER: t('Starter'), GROWTH: t('Growth'), ENTERPRISE: t('Enterprise') };
const LIMIT_LABELS: Record<PlanLimit, string> = {
  runningCampaigns: t('Running campaigns'),
  members: t('Team members and open invitations'),
  scheduledReports: t('Scheduled reports'),
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
            ? t('Payment received: {money} added to your balance.', {
                money: formatMoney(entry.amountCents),
              })
            : t('Stripe has not confirmed the payment yet. It will appear here once it does.'),
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
      <h2>{t('Add credit')}</h2>
      {!data.cardPayments ? (
        <p className="muted">
          {t(
            "Card payments aren't set up on this platform. Ask the platform team to add credit, for example when your bank transfer arrives.",
          )}
        </p>
      ) : !isOwner ? (
        <p className="muted">{t('Owners can add credit by card.')}</p>
      ) : (
        <form className="credit-form" onSubmit={pay} aria-label={t('Pay by card')}>
          <label>
            {t('Amount ({currency})', { currency })}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1000"
              required
            />
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? t('Opening Stripe…') : t('Pay by card')}
          </button>
          <p className="muted small">
            {data.rate
              ? t(
                  "You pay on Stripe's secure page. It's added to your balance in euros at today's rate: 1 EUR = {rate} {currency}.",
                  { rate: formatDecimal(data.rate.rate, 4), currency },
                )
              : t("You pay on Stripe's secure page.")}
          </p>
        </form>
      )}
      <ErrorNote message={error} />
    </section>
  );
};

export const PlanUsage = ({ data }: { data: BillingOverview }) => (
  <section className="card">
    <h2>{t('Plan: {value}', { value: PLAN_NAMES[data.plan] })}</h2>
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
                  ? t('{number}, no limit', { number: formatNumber(used) })
                  : t('{number} of {number2}', {
                      number: formatNumber(used),
                      number2: formatNumber(max),
                    })}
              </span>
            </div>
            {max !== null && (
              <Progress label={LIMIT_LABELS[limit]} rate={max > 0 ? used / max : 1} />
            )}
          </div>
        );
      })}
    </div>
    <p className="muted small">{t('A platform admin changes the plan.')}</p>
  </section>
);

const VAT_CHECK: Record<NonNullable<BillingDetails['vatCheck']>, string> = {
  valid: t('The EU confirmed this VAT ID.'),
  invalid: t('The EU does not know this VAT ID, so German VAT is charged.'),
  unavailable: t(
    "The EU's VAT check isn't answering right now, so German VAT is charged. Save again later.",
  ),
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
      <h2>{t('Billing details')}</h2>
      <p className="muted small">
        {isOwner
          ? t('Printed on your invoices. Your country and VAT ID decide the VAT.')
          : t(
              'Printed on your invoices. Your country and VAT ID decide the VAT. Owners can change them.',
            )}
      </p>
      <form className="details-form" onSubmit={save}>
        {field('billingName', t('Company name'))}
        {field('addressLine1', t('Address'))}
        {field('addressLine2', t('Address, second line'))}
        {field('postalCode', t('Postcode'))}
        {field('city', t('City'))}
        <label>
          {t('Country')}
          <select
            value={form.country}
            onChange={(event) =>
              setForm((current) => ({ ...current, country: event.target.value }))
            }
            disabled={!isOwner}
          >
            <option value="">{t('Choose a country')}</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {field('vatId', t('VAT ID'), { placeholder: t('For example FR12345678901') })}
        <label>
          {t('Pay and be invoiced in')}
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
              {busy ? t('Saving…') : t('Save details')}
            </button>
          </div>
        )}
      </form>
      <div aria-live="polite">
        <p className="small">
          <span className="badge badge-neutral">
            {t('VAT {value}%', { value: shown.vat.rateBp / 100 })}
          </span>{' '}
          {shown.vat.note || t('German VAT applies.')}
        </p>
        {result?.vatCheck && VAT_CHECK[result.vatCheck] && (
          <p className="muted small">{VAT_CHECK[result.vatCheck]}</p>
        )}
      </div>
      <ErrorNote message={error} />
    </section>
  );
};
