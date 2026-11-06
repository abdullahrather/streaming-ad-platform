# How billing works

Campaigns are paid from a prepaid balance. An advertiser pays in first, and delivered ads are charged against that money. The platform can never deliver ads nobody has paid for.

## The balance

Each organisation's balance is an append-only ledger in `balance_entries`, kept in euros, the platform's currency:

| Entry | Amount | Example |
|---|---|---|
| **Credit** | Positive | "Bank transfer received", added by a platform admin, or "Card payment: 50.00 GBP" through Stripe |
| **Charge** | Negative | "Invoice INV-2026-00012: Spring Coats", one per invoice |

The balance is the sum of the entries. Entries are never edited or deleted, so the history always explains the balance.

## What running campaigns hold

Budgets are net amounts in euros. The balance pays the whole invoice, VAT included, so a running campaign holds its unspent budget plus the organisation's VAT rate. The rest of the balance is **available**:

```
held      = (budget − spent so far) × (1 + VAT rate), for each running campaign
available = balance − held
```

| Change | Needs available balance for |
|---|---|
| Creating a running campaign | Its whole budget, plus VAT |
| Resuming a paused campaign | Its unspent budget, plus VAT |
| Raising a running campaign's budget | Its new unspent budget, plus VAT |
| Pausing, lowering a budget, changing targeting | Nothing |

A change that needs more than is available is refused with `402` and a message saying how much is needed and how much is available. Paused campaigns hold nothing, so pausing one frees its money for another.

**Why holds rather than checking every ad:** budgets are already hard limits in the ad server, reserved in the same atomic step as each ad. A campaign can't spend past its budget, and its budget is covered by the balance, so spend can never pass the balance. Ad decisions never read the balance, so delivery stays as fast as before.

**Two changes at once:** one organisation's billing changes take a PostgreSQL advisory lock for the length of their transaction. Two campaigns started at the same moment can't both claim the same money; the second waits, then sees the first one's hold.

## Invoices

Each campaign gets one invoice, for what it really cost. Auctions can clear below the CPM, so the amount is the recorded cost, not impressions × CPM.

1. **The campaign finishes.** It reaches its goal or budget (the ad server records `completed_at`), or its end date passes.
2. **Its delivery becomes final.** Events can arrive up to `EVENT_DEDUPE_SECONDS` late (an hour by default), and the queue needs a moment, so the invoice waits that long plus ten minutes.
3. **The scheduler issues it.** Every five minutes, in one transaction:
   - Number the invoice. Numbers run in order within each year, with no gaps: `INV-2026-00001`, `INV-2026-00002` and so on.
   - Work out the VAT and convert to the organisation's currency.
   - Copy the totals, names and addresses in, so the invoice reads the same after anything changes.
   - Charge the euro total to the ledger.
   - Close the campaign.
4. **The owners get an email** with the PDF attached. Owners and managers can download it again from the Billing page.

The rest of the hold is freed at the same moment, so available balance goes up by whatever the campaign didn't spend.

- **Nothing spent:** the campaign is closed without an invoice.
- **A campaign is deleted:** what it spent is invoiced first, because its delivery data is deleted with it.
- **Invalid traffic:** it's never billed, and the invoice says how many events were removed.
- **Two processes at once:** a campaign is claimed before it's billed, so it's invoiced exactly once, even with several API processes.
- **No rate for the currency yet:** the invoice waits for the next try, rather than being issued with a guessed rate.

Amounts are kept to a thousandth of a cent while ads deliver, and rounded to the cent once, on the invoice.

## VAT

The platform is the seller, in Germany, and its customers are businesses. Owners fill in their billing details (company name, address, country and VAT ID) on the Billing page, and those decide the VAT:

| Customer | VAT on the invoice | Note on the invoice |
|---|---|---|
| In Germany, or no country given | 19% German VAT | |
| In another EU country, VAT ID confirmed by VIES | None: the reverse charge | The recipient accounts for the VAT (Article 196, Directive 2006/112/EC) |
| In another EU country, no confirmed VAT ID | 19% German VAT | Why German VAT was charged |
| Outside the EU | None | Not subject to German VAT (§ 3a (2) UStG) |

- **VIES** is the EU's free service for checking VAT IDs. It's checked when an owner saves their details, and only a confirmed ID gets the reverse charge.
- **When VIES or a country's own system is down,** the answer is "unavailable", not "invalid". German VAT applies until the owner saves again and the check succeeds.
- **A VAT ID must start with its country's code.** Greece uses EL.
- **VAT is worked out on the rounded net amount.**

The seller's name, address and VAT ID come from `SELLER_NAME`, `SELLER_ADDRESS` and `SELLER_VAT_ID`. The defaults are fictional.

## Currencies

Prices, budgets and the balance are in euros. Each organisation chooses the currency it pays and is invoiced in: EUR, GBP, CHF, SEK, DKK, NOK, PLN, CZK or USD.

- **Rates:** the European Central Bank's daily reference rates, which are free and public. They're fetched soon after startup and every six hours, and stored, so each invoice keeps the rate it used.
- **Invoices** show their amounts in the organisation's currency, the rate, and the same amounts in euros. EU rules require the VAT to be stated in euros too.
- **Card payments** in another currency are added to the balance in euros at the day's rate. The ledger keeps what was actually paid.
- **The Billing page** also shows the balance in the organisation's currency, at today's rate.

## Card payments

Card payments are optional. They use the runner's own Stripe account: set `STRIPE_SECRET_KEY`, and test-mode keys work with Stripe's test cards, with no real money. Without a key, the Billing page says card payments aren't set up, and admins add credit by hand.

1. An owner enters an amount in their currency and goes to Stripe's hosted payment page.
2. Stripe sends them back to the Billing page, which asks the server to check the payment with Stripe.
3. Once it's paid, it's added to the balance.

The check on return needs no public address, so card payments work on a laptop. In production, also point a Stripe webhook at `POST /billing/stripe/webhook` for `checkout.session.completed` and set `STRIPE_WEBHOOK_SECRET`. The webhook signature is checked against the raw request body before anything is read.

A payment is credited once, however it arrives and however often. Each Checkout Session can create only one ledger entry, enforced by the database. Only owners can pay, and only for their own organisation.

## Plans

Plans set how much an organisation may use. A platform admin assigns them on the Billing page. New organisations start on Starter, and organisations from before plans moved to Growth.

| | Starter | Growth | Enterprise |
|---|---|---|---|
| Running campaigns | 2 | 10 | No limit |
| Team members, counting open invitations | 3 | 10 | No limit |
| Scheduled reports | 1 | 10 | No limit |

- **Going over is refused with `402`** and the plan's limit in the message: starting or resuming a campaign, inviting someone, or scheduling a report.
- **Moving to a smaller plan doesn't stop anything already running.** It only blocks adding more.
- **Plans have no fee of their own:** advertisers pay for the ads they run.
- **The running-campaign count is checked under the same organisation lock as the balance,** so two starts at once can't both slip under the limit.

## Publisher revenue

The platform is the publisher: the streaming service whose shows carry the ads. Platform admins see what it earned on the Billing page and at `GET /billing/revenue`:

- **Revenue delivered** in the period, by show, by advertiser and by ad slot.
- **eCPM:** revenue per 1,000 impressions, the usual way to compare earnings across shows and slots.
- **Invoiced** in the period (net, in euros), **credit paid in**, and revenue **not yet invoiced**, which is what running campaigns have spent so far.

## Who can do what

| Role | Billing |
|---|---|
| Owner | Their organisation's balance, holds, plan, invoices and history; change billing details; pay by card |
| Manager | The same, but can't change billing details or pay |
| Analyst, guest | No access |
| Platform admin | Every organisation's balance, add credit, change plans, publisher revenue, any invoice |

Adding credit, changing a plan and changing billing details are recorded in the activity log.

## Upgrading

- **Already-finished campaigns:** the first billing migration closes them, so they aren't invoiced after the fact. Campaigns still running are invoiced when they end.
- **Running campaigns from before billing** hold their unspent budget plus VAT straight away. Until credit is added, an organisation's available balance can be below zero: its campaigns keep delivering, but it can't start or resume another.
- **Plans:** organisations from before plans move to Growth.
- **Earlier invoices:** they stay in euros with no VAT.

## Limits

- **Card payments were tested against a local stand-in for Stripe,** not against Stripe's real test mode, which needs the runner's own account.
- **The VAT rules cover one seller in Germany selling to businesses.** There's no VAT for consumers in other EU countries (OSS), because advertisers are businesses.
- **One invoice per campaign, at the end.** A long campaign isn't invoiced monthly.
- **Exchange rates come from the ECB** and are only as fresh as its last working-day publication.
