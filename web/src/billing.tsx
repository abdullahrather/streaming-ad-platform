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
          label: 'Balance',
          value: formatMoney(data.balanceCents),
          ...(data.rate
            ? {
                note: `About ${formatMoney(Math.round(data.balanceCents * data.rate.rate), data.rate.currency)}`,
              }
            : {}),
        },
        {
          label: 'Held by running campaigns',
          value: formatMoney(data.heldCents),
          note:
            data.vatRateBp > 0
              ? `Their unspent budgets plus ${data.vatRateBp / 100}% VAT`
              : 'Their unspent budgets',
        },
        {
          label: 'Available',
          value: formatMoney(data.availableCents),
          note: 'For new or resumed campaigns',
        },
      ]}
    />

    <section className="card">
      <h2>What running campaigns hold</h2>
      {data.reservations.length === 0 ? (
        <p className="muted">No campaign is running, so nothing is held.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col" className="num">
                  Budget
                </th>
                <th scope="col" className="num">
                  Spent
                </th>
                <th scope="col" className="num">
                  Held
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
      <h2>Invoices</h2>
      {data.invoices.length === 0 ? (
        <p className="muted">
          No invoices yet. A campaign is invoiced about an hour after it ends.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Campaign</th>
                <th scope="col">Flight</th>
                <th scope="col" className="num">
                  Impressions
                </th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">
                  <span className="sr-only">Download</span>
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
                      aria-label={`Download invoice ${invoice.number} as a PDF`}
                      onClick={() => void api.downloadInvoice(invoice.id)}
                    >
                      PDF
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
      <h2>History</h2>
      {data.entries.length === 0 ? (
        <p className="muted">No payments or charges yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">What</th>
                <th scope="col" className="num">
                  Amount
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
  const [description, setDescription] = useState('Bank transfer received');
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
        setMessage(`Added ${formatMoney(amountCents)} to ${target.name}.`);
        setEuros('');
        refresh();
      })
      .catch((reason: unknown) => setFailure(errorText(reason)));
  };

  return (
    <section className="card">
      <h2>Organisations</h2>
      <ErrorNote message={error} />
      {data && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Plan</th>
                  <th scope="col" className="num">
                    Balance
                  </th>
                  <th scope="col" className="num">
                    Held
                  </th>
                  <th scope="col" className="num">
                    Available
                  </th>
                  <th scope="col" className="num">
                    Invoices
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
                        aria-label={`Plan for ${row.name}`}
                        value={row.plan}
                        onChange={(event) => changePlan(row.id, event.target.value as PlanName)}
                      >
                        <option value="STARTER">Starter</option>
                        <option value="GROWTH">Growth</option>
                        <option value="ENTERPRISE">Enterprise</option>
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

          <form className="credit-form" onSubmit={submit} aria-label="Add credit">
            <h3>Add credit</h3>
            <label>
              Organisation
              <select value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
                {data.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount (€)
              <input
                inputMode="decimal"
                value={euros}
                onChange={(e) => setEuros(e.target.value)}
                placeholder="5000"
                required
              />
            </label>
            <label>
              Note
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <button type="submit" className="button primary">
              Add credit
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
      <p className="muted">No delivery in this period.</p>
    ) : (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{title.replace(/^By /, '').replace(/^./, (c) => c.toUpperCase())}</th>
              <th scope="col" className="num">
                Impressions
              </th>
              <th scope="col" className="num">
                Revenue
              </th>
              <th scope="col" className="num">
                eCPM
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
          <h2>Publisher revenue</h2>
          <p className="muted small">
            What advertisers paid for ads shown on the platform. eCPM is revenue per 1,000
            impressions.
          </p>
        </div>
        <RangePicker value={rangeId} onChange={setRangeId} />
      </header>
      <ErrorNote message={error} />
      {data ? (
        <>
          <Tiles
            items={[
              { label: 'Revenue delivered', value: formatMoney(data.revenueCents) },
              { label: 'Impressions', value: formatNumber(data.impressions) },
              {
                label: 'Invoiced',
                value: formatMoney(data.invoicedCents),
                note: `${formatNumber(data.invoiceCount)} invoices in this period`,
              },
              { label: 'Credit paid in', value: formatMoney(data.creditsCents) },
              {
                label: 'Not yet invoiced',
                value: formatMoney(data.unbilledCents),
                note: 'Running campaigns, all time',
              },
            ]}
          />
          <div className="columns">
            <RevenueTable title="By show" rows={data.byShow} />
            <RevenueTable title="By advertiser" rows={data.byOrganisation} />
            <RevenueTable title="By ad slot" rows={data.bySlot} labels={SLOT_LABELS} />
          </div>
        </>
      ) : (
        !error && <p className="empty">Loading…</p>
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
        !error && <p className="empty">Loading…</p>
      )}
    </>
  );
};

export const BillingPage = ({ user }: { user: User }) => (
  <>
    <header className="page-header">
      <div>
        <h1>Billing</h1>
        <p className="muted">
          Campaigns are paid from a prepaid balance. A running campaign holds its unspent budget, so
          it can't spend money that isn't there. About an hour after a campaign ends, it's invoiced
          for what it delivered and the rest is freed.
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
