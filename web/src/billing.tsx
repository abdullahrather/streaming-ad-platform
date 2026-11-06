import { useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type BillingOverview,
  type OrganisationAccount,
  type PlanName,
  type RevenueRow,
  type User,
} from './api';
import { AddCredit, BillingDetailsForm, CheckoutReturn, PlanUsage } from './billing-account';
import { RangePicker } from './components';
import { SLOT_LABELS, formatDate, formatDateTime, formatMoney, formatNumber } from './format';
import { rangeFor, useLiveData } from './hooks';
import { ErrorNote, firstError } from './ui';
import { t } from './i18n';

const errorText = (reason: unknown): string =>
  reason instanceof ApiError ? firstError(reason) : String(reason);

const Tiles = ({ items }: { items: Array<{ label: string; value: string; note?: string }> }) => (
  <dl className="kpis">
    {items.map(({ label, value, note }) => (
      <div key={label} className="card kpi">
        <dt>{label}</dt>
        <dd>{value}</dd>
        {note ? <dd className="muted small kpi-note-line">{note}</dd> : null}
      </div>
    ))}
  </dl>
);

const signed = (cents: number): string =>
  cents < 0 ? `−${formatMoney(-cents)}` : `+${formatMoney(cents)}`;

/** An organisation's own balance, holds, plan, details, history and invoices. */
const OwnBilling = ({
  data,
  isOwner,
  refresh,
}: {
  data: BillingOverview;
  isOwner: boolean;
  refresh: () => void;
}) => (
  <>
    <CheckoutReturn onCredited={refresh} />
    <Tiles
      items={[
        {
          label: t('Balance'),
          value: formatMoney(data.balanceCents),
          ...(data.rate
            ? {
                note: t('About {money}', {
                  money: formatMoney(
                    Math.round(data.balanceCents * data.rate.rate),
                    data.rate.currency,
                  ),
                }),
              }
            : {}),
        },
        {
          label: t('Held by running campaigns'),
          value: formatMoney(data.heldCents),
          note:
            data.vatRateBp > 0
              ? t('Their unspent budgets plus {value}% VAT', { value: data.vatRateBp / 100 })
              : t('Their unspent budgets'),
        },
        {
          label: t('Available'),
          value: formatMoney(data.availableCents),
          note: t('For new or resumed campaigns'),
        },
      ]}
    />

    <section className="card">
      <h2>{t('What running campaigns hold')}</h2>
      {data.reservations.length === 0 ? (
        <p className="muted">{t('No campaign is running, so nothing is held.')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('Campaign')}</th>
                <th scope="col" className="num">
                  {t('Budget')}
                </th>
                <th scope="col" className="num">
                  {t('Spent')}
                </th>
                <th scope="col" className="num">
                  {t('Held')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.reservations.map((row) => (
                <tr key={row.campaignId}>
                  <td>
                    <a href={`#/campaigns/${row.campaignId}`}>{row.title}</a>
                  </td>
                  <td className="num">{formatMoney(row.budgetCents)}</td>
                  <td className="num">{formatMoney(row.spentCents)}</td>
                  <td className="num">{formatMoney(row.heldCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <div className="columns">
      <AddCredit data={data} isOwner={isOwner} />
      <PlanUsage data={data} />
    </div>
    <BillingDetailsForm details={data.details} isOwner={isOwner} onSaved={refresh} />

    <section className="card">
      <h2>{t('Invoices')}</h2>
      {data.invoices.length === 0 ? (
        <p className="muted">
          {t('No invoices yet. A campaign is invoiced about an hour after it ends.')}
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('Invoice')}</th>
                <th scope="col">{t('Campaign')}</th>
                <th scope="col">{t('Flight')}</th>
                <th scope="col" className="num">
                  {t('Impressions')}
                </th>
                <th scope="col" className="num">
                  {t('Total')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('Download')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    {invoice.number}
                    <div className="muted small">{formatDate(invoice.issuedAt)}</div>
                  </td>
                  <td>
                    {invoice.campaignTitle}
                    <div className="muted small">{invoice.advertiser}</div>
                  </td>
                  <td>
                    {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
                  </td>
                  <td className="num">{formatNumber(invoice.impressions)}</td>
                  <td className="num">{formatMoney(invoice.totalCents, invoice.currency)}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      aria-label={t('Download invoice {number} as a PDF', {
                        number: invoice.number,
                      })}
                      onClick={() => void api.downloadInvoice(invoice.id)}
                    >
                      {t('PDF')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section className="card">
      <h2>{t('History')}</h2>
      {data.entries.length === 0 ? (
        <p className="muted">{t('No payments or charges yet.')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('Date')}</th>
                <th scope="col">{t('What')}</th>
                <th scope="col" className="num">
                  {t('Amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>{entry.description}</td>
                  <td className={`num ${entry.amountCents < 0 ? '' : 'positive'}`}>
                    {signed(entry.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </>
);

/** Every organisation's balance, and adding credit when a payment arrives. */
const Organisations = () => {
  const { data, error, refresh } = useLiveData(() => api.billingOrganisations(), 'organisations');
  const [organisationId, setOrganisationId] = useState('');
  const [euros, setEuros] = useState('');
  const [description, setDescription] = useState(t('Bank transfer received'));
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');

  const changePlan = (id: string, plan: PlanName): void => {
    setFailure('');
    api
      .setPlan(id, plan)
      .then(refresh)
      .catch((reason: unknown) => setFailure(errorText(reason)));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure('');
    setMessage('');
    const target = data?.find(({ id }) => id === (organisationId || data[0]?.id));
    const amountCents = Math.round(Number(euros.replace(',', '.')) * 100);
    if (!target) return;
    api
      .addCredit(target.id, amountCents, description)
      .then(() => {
        setMessage(
          t('Added {money} to {name}.', { money: formatMoney(amountCents), name: target.name }),
        );
        setEuros('');
        refresh();
      })
      .catch((reason: unknown) => setFailure(errorText(reason)));
  };

  return (
    <section className="card">
      <h2>{t('Organisations')}</h2>
      <ErrorNote message={error} />
      {data && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('Organisation')}</th>
                  <th scope="col">{t('Plan')}</th>
                  <th scope="col" className="num">
                    {t('Balance')}
                  </th>
                  <th scope="col" className="num">
                    {t('Held')}
                  </th>
                  <th scope="col" className="num">
                    {t('Available')}
                  </th>
                  <th scope="col" className="num">
                    {t('Invoices')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row: OrganisationAccount) => (
                  <tr key={row.id}>
                    <td>
                      {row.name}
                      <div className="muted small">
                        {[row.country, row.currency].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <select
                        aria-label={t('Plan for {name}', { name: row.name })}
                        value={row.plan}
                        onChange={(event) => changePlan(row.id, event.target.value as PlanName)}
                      >
                        <option value="STARTER">{t('Starter')}</option>
                        <option value="GROWTH">{t('Growth')}</option>
                        <option value="ENTERPRISE">{t('Enterprise')}</option>
                      </select>
                    </td>
                    <td className="num">{formatMoney(row.balanceCents)}</td>
                    <td className="num">{formatMoney(row.heldCents)}</td>
                    <td className="num">{formatMoney(row.availableCents)}</td>
                    <td className="num">{formatNumber(row.invoices)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form className="credit-form" onSubmit={submit} aria-label={t('Add credit')}>
            <h3>{t('Add credit')}</h3>
            <label>
              {t('Organisation')}
              <select value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
                {data.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('Amount (€)')}
              <input
                inputMode="decimal"
                value={euros}
                onChange={(e) => setEuros(e.target.value)}
                placeholder="5000"
                required
              />
            </label>
            <label>
              {t('Note')}
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <button type="submit" className="button primary">
              {t('Add credit')}
            </button>
          </form>
          <p className="muted small" aria-live="polite">
            {message}
          </p>
          <ErrorNote message={failure} />
        </>
      )}
    </section>
  );
};

const RevenueTable = ({
  title,
  rows,
  labels,
}: {
  title: string;
  rows: RevenueRow[];
  labels?: Record<string, string>;
}) => (
  <section className="card">
    <h3>{title}</h3>
    {rows.length === 0 ? (
      <p className="muted">{t('No delivery in this period.')}</p>
    ) : (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{title.replace(/^By /, '').replace(/^./, (c) => c.toUpperCase())}</th>
              <th scope="col" className="num">
                {t('Impressions')}
              </th>
              <th scope="col" className="num">
                {t('Revenue')}
              </th>
              <th scope="col" className="num">
                {t('eCPM')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>
                  {labels?.[row.label] ?? row.label}
                  {row.genre ? <div className="muted small">{row.genre}</div> : null}
                </td>
                <td className="num">{formatNumber(row.impressions)}</td>
                <td className="num">{formatMoney(row.revenueCents)}</td>
                <td className="num">{formatMoney(row.ecpmCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

/** What the platform earned as the publisher. */
const PublisherRevenue = () => {
  const [rangeId, setRangeId] = useState('30d');
  const { data, error } = useLiveData(() => api.revenue(rangeFor(rangeId)), rangeId);

  return (
    <>
      <header className="page-header section-header">
        <div>
          <h2>{t('Publisher revenue')}</h2>
          <p className="muted small">
            {t(
              'What advertisers paid for ads shown on the platform. eCPM is revenue per 1,000 impressions.',
            )}
          </p>
        </div>
        <RangePicker value={rangeId} onChange={setRangeId} />
      </header>
      <ErrorNote message={error} />
      {data ? (
        <>
          <Tiles
            items={[
              { label: t('Revenue delivered'), value: formatMoney(data.revenueCents) },
              { label: t('Impressions'), value: formatNumber(data.impressions) },
              {
                label: t('Invoiced'),
                value: formatMoney(data.invoicedCents),
                note: t('{number} invoices in this period', {
                  number: formatNumber(data.invoiceCount),
                }),
              },
              { label: t('Credit paid in'), value: formatMoney(data.creditsCents) },
              {
                label: t('Not yet invoiced'),
                value: formatMoney(data.unbilledCents),
                note: t('Running campaigns, all time'),
              },
            ]}
          />
          <div className="columns">
            <RevenueTable title={t('By show')} rows={data.byShow} />
            <RevenueTable title={t('By advertiser')} rows={data.byOrganisation} />
            <RevenueTable title={t('By ad slot')} rows={data.bySlot} labels={SLOT_LABELS} />
          </div>
        </>
      ) : (
        !error && <p className="empty">{t('Loading…')}</p>
      )}
    </>
  );
};

const OwnBillingPage = ({ user }: { user: User }) => {
  const { data, error, refresh } = useLiveData(() => api.billing(), user.organisationId ?? 'none');
  return (
    <>
      <ErrorNote message={error} />
      {data ? (
        <OwnBilling data={data} isOwner={user.organisationRole === 'OWNER'} refresh={refresh} />
      ) : (
        !error && <p className="empty">{t('Loading…')}</p>
      )}
    </>
  );
};

export const BillingPage = ({ user }: { user: User }) => (
  <>
    <header className="page-header">
      <div>
        <h1>{t('Billing')}</h1>
        <p className="muted">
          {t(
            "Campaigns are paid from a prepaid balance. A running campaign holds its unspent budget, so it can't spend money that isn't there. About an hour after a campaign ends, it's invoiced for what it delivered and the rest is freed.",
          )}
        </p>
      </div>
    </header>
    {user.role === 'ADMIN' ? (
      <>
        <Organisations />
        <PublisherRevenue />
      </>
    ) : (
      <OwnBillingPage user={user} />
    )}
  </>
);
