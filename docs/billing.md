# How billing works

Campaigns are paid from a prepaid balance. An advertiser pays in first, and delivered ads are charged against that money. The platform can never deliver ads nobody has paid for.

## The balance

Each organisation's balance is an append-only ledger in `balance_entries`:

| Entry | Amount | Example |
|---|---|---|
| **Credit** | Positive | "Bank transfer received", added by a platform admin |
| **Charge** | Negative | "Invoice INV-2026-00012: Spring Coats", one per invoice |

The balance is the sum of the entries. Entries are never edited or deleted, so the history always explains the balance.

## What running campaigns hold

A running campaign holds its unspent budget: budget minus what it has spent so far. The rest of the balance is **available**:

```
available = balance − what running campaigns hold
```

| Change | Needs available balance for |
|---|---|
| Creating a running campaign | Its whole budget |
| Resuming a paused campaign | Its unspent budget |
| Raising a running campaign's budget | Its new unspent budget |
| Pausing, lowering a budget, changing targeting | Nothing |

A change that needs more than is available is refused with `402` and a message that says how much is needed and how much is available. Paused campaigns hold nothing, so pausing one frees its money for another.

**Why holds rather than checking every ad:** budgets are already hard limits in the ad server, reserved in the same atomic step as each ad. A campaign can't spend past its budget, and its budget is covered by the balance, so spend can never pass the balance. Ad decisions never need to read the balance, so delivery stays as fast as before.

**Two changes at once:** one organisation's billing changes take a PostgreSQL advisory lock for the length of their transaction. Two campaigns started at the same moment can't both claim the same money; the second waits, then sees the first one's hold.

## Invoices

Each campaign gets one invoice, for what it really cost. Auctions can clear below the CPM, so the amount is the recorded cost, not impressions × CPM.

1. **The campaign finishes.** It reaches its goal or budget (the ad server records `completed_at`), or its end date passes.
2. **Its delivery becomes final.** Events can arrive up to `EVENT_DEDUPE_SECONDS` late (an hour by default), and the queue needs a moment, so the invoice waits that long plus ten minutes.
3. **The scheduler issues it.** Every five minutes, in one transaction:
   - Number the invoice. Numbers run in order within each year, with no gaps: `INV-2026-00001`, `INV-2026-00002` and so on.
   - Copy the totals and names in, so the invoice reads the same after the campaign is renamed or deleted.
   - Add the charge to the ledger.
   - Close the campaign.
4. **The owners get an email** with the PDF attached. Owners and managers can download it again from the Billing page.

The rest of the hold is freed at the same moment, so available balance goes up by whatever the campaign didn't spend.

- **Nothing spent:** the campaign is closed without an invoice.
- **A campaign is deleted:** what it spent is invoiced first, because its delivery data is deleted with it.
- **Invalid traffic:** it's never billed, and the invoice says how many events were removed.
- **Two processes at once:** a campaign is claimed before it's billed, so it's invoiced exactly once, even with several API processes.

Amounts are kept to a thousandth of a cent while ads deliver, and rounded to the cent once, on the invoice.

## Publisher revenue

The platform is the publisher: the streaming service whose shows carry the ads. Platform admins see what it earned on the Billing page and at `GET /billing/revenue`:

- **Revenue delivered** in the period, by show, by advertiser and by ad slot.
- **eCPM:** revenue per 1,000 impressions, the usual way to compare earnings across shows and slots.
- **Invoiced** in the period, **credit paid in**, and revenue **not yet invoiced**, which is what running campaigns have spent so far.

## Who can do what

| Role | Billing |
|---|---|
| Owner, manager | See their organisation's balance, holds, history and invoices; download invoices |
| Analyst, guest | No access |
| Platform admin | Every organisation's balance, add credit, publisher revenue, any invoice |

Adding credit is recorded in the activity log.

## Upgrading

The migration closes campaigns that had already finished, so they aren't invoiced after the fact. Campaigns still running are invoiced when they end.

Running campaigns from before the upgrade hold their unspent budget straight away. Until credit is added, an organisation's available balance can be below zero: its running campaigns keep delivering, but it can't start or resume another.

## Limits

- **Credit is added by a platform admin**, for example when a bank transfer arrives. There's no online payment yet.
- **Euros only, and no VAT.** Invoices are net amounts and say so.
- **One invoice per campaign, at the end.** A long campaign isn't invoiced monthly.
- **The seller's name on invoices is fixed** as "Campaign Analytics".
