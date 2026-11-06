/**
 * src/modules/billing/billing.service.ts
 *
 * Prepaid billing. Each organisation has a balance, kept as an append-only ledger of
 * credits and charges. A running campaign holds its unspent budget against that
 * balance, so a campaign can only start, resume or grow its budget when the money is
 * there. Budgets are already hard limits in the ad server, so spend can never pass the
 * balance, and ad decisions never need to check it.
 *
 * When a campaign's delivery is final, it gets one invoice for what it really cost,
 * paid from the balance in the same transaction. Delivery is final an hour after the
 * campaign ends, because events can arrive up to EVENT_DEDUPE_SECONDS late.
 */
import { Prisma, type BalanceEntry, type Invoice } from '@prisma/client';
import { z } from 'zod';
import { env } from '@/config/env';
import { canManageCampaigns, type Actor } from '@/lib/actor';
import { deliverEmail } from '@/lib/mailer';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import type { DateRange } from '@/modules/campaigns/campaigns.schema';
import { decisionCache } from '@/modules/delivery/decision-cache';
import { invoicePdf } from './billing.pdf';

type Db = Prisma.TransactionClient | typeof prisma;

/** Late events are refused after the duplicate window; the margin covers the queue. */
export const SETTLE_MS = env.EVENT_DEDUPE_SECONDS * 1000 + 10 * 60_000;

export const creditSchema = z.object({
  amountCents: z
    .number({ error: 'Enter an amount.' })
    .int()
    .positive({ error: 'Enter an amount above zero.' })
    .max(1_000_000_000, { error: 'That amount is too large.' }),
  description: z.string().trim().min(3).max(200).default('Payment received'),
});

export const formatEuros = (cents: number): string =>
  `€${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface Reservation {
  campaignId: string;
  title: string;
  budgetCents: number;
  spentCents: number;
  heldCents: number;
}

export interface Overview extends Account {
  entries: Array<
    Pick<BalanceEntry, 'id' | 'kind' | 'amountCents' | 'description' | 'createdAt' | 'invoiceId'>
  >;
  invoices: Invoice[];
}

export interface OrganisationAccount extends Account {
  id: string;
  name: string;
  invoices: number;
}

export interface RevenueRow {
  label: string;
  genre?: string;
  impressions: number;
  revenueCents: number;
  ecpmCents: number;
}

export interface Revenue {
  from: string;
  to: string;
  impressions: number;
  revenueCents: number;
  invoicedCents: number;
  invoiceCount: number;
  creditsCents: number;
  unbilledCents: number;
  byShow: RevenueRow[];
  byOrganisation: RevenueRow[];
  bySlot: RevenueRow[];
}

export interface Account {
  balanceCents: number;
  heldCents: number;
  availableCents: number;
  reservations: Reservation[];
}

/** Spend so far per campaign, rounded down so what's held is never too little. */
const spentByCampaign = async (db: Db, ids: string[]): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ campaignId: string; cost: bigint }>>`
    SELECT campaign_id AS "campaignId", COALESCE(SUM(cost_millicents), 0)::bigint AS cost
    FROM metrics WHERE campaign_id = ANY(${ids}::text[]) GROUP BY campaign_id
  `;
  return new Map(rows.map(({ campaignId, cost }) => [campaignId, Math.floor(Number(cost) / 1000)]));
};

/** One organisation's billing changes run one at a time, so two can't spend the same money. */
const lock = (db: Db, organisationId: string): Promise<unknown> =>
  db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${organisationId}`}))`;

class BillingService {
  async account(organisationId: string, db: Db = prisma): Promise<Account> {
    const [sum, running] = await Promise.all([
      db.balanceEntry.aggregate({ where: { organisationId }, _sum: { amountCents: true } }),
      db.campaign.findMany({
        where: { organisationId, status: 'ACTIVE', billedAt: null },
        select: { id: true, title: true, budgetCents: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const spent = await spentByCampaign(
      db,
      running.map(({ id }) => id),
    );
    const reservations = running.map(({ id, title, budgetCents }) => {
      const spentCents = spent.get(id) ?? 0;
      return {
        campaignId: id,
        title,
        budgetCents,
        spentCents,
        heldCents: Math.max(0, budgetCents - spentCents),
      };
    });
    const balanceCents = sum._sum.amountCents ?? 0;
    const heldCents = reservations.reduce((total, { heldCents: held }) => total + held, 0);
    return { balanceCents, heldCents, availableCents: balanceCents - heldCents, reservations };
  }

  /**
   * Refuses a change that would make a campaign hold more than is available. Call it
   * inside the transaction that makes the change. Locks the organisation's billing
   * until that transaction ends.
   */
  async assertAffordable(
    tx: Prisma.TransactionClient,
    organisationId: string,
    campaignId: string | null,
    budgetCents: number,
  ): Promise<void> {
    await lock(tx, organisationId);
    const account = await this.account(organisationId, tx);
    const current = account.reservations.find((r) => r.campaignId === campaignId);
    const spent = campaignId
      ? (current?.spentCents ?? (await spentByCampaign(tx, [campaignId])).get(campaignId) ?? 0)
      : 0;
    const needed = Math.max(0, budgetCents - spent);
    const available = account.availableCents + (current?.heldCents ?? 0);
    if (needed > available) {
      throw new AppError(
        402,
        `Not enough balance. This campaign needs ${formatEuros(needed)} of its budget, and ${formatEuros(Math.max(0, available))} is available. Add credit on the Billing page, or lower the budget.`,
      );
    }
  }

  /** Adds money to an organisation's balance, such as a bank transfer received. */
  async credit(
    actorId: string,
    organisationId: string,
    dto: z.infer<typeof creditSchema>,
  ): Promise<BalanceEntry> {
    const organisation = await prisma.organisation.findUnique({ where: { id: organisationId } });
    if (!organisation) throw new AppError(404, 'Organisation not found.');
    return prisma.balanceEntry.create({
      data: {
        organisationId,
        kind: 'CREDIT',
        amountCents: dto.amountCents,
        description: dto.description,
        createdById: actorId,
      },
    });
  }

  /** Campaigns whose delivery is final and that haven't been billed. */
  async settledCampaigns(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - SETTLE_MS);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM campaigns
      WHERE billed_at IS NULL
        AND CASE WHEN status = 'COMPLETED' THEN COALESCE(completed_at, updated_at) ELSE ends_at END
            <= ${cutoff}
      ORDER BY ends_at
      LIMIT 200
    `;
    return rows.map(({ id }) => id);
  }

  /**
   * Bills a finished campaign: one invoice for its delivery, paid from the balance, and
   * the campaign closed. Safe to call more than once. Returns null when there was
   * nothing to bill.
   */
  async issueInvoice(campaignId: string, now = new Date()): Promise<Invoice | null> {
    const invoice = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        include: { organisation: { select: { name: true } } },
      });
      if (!campaign || campaign.billedAt) return null;
      await lock(tx, campaign.organisationId);
      // It finished when it reached its goal or budget, or when its flight ended.
      const finishedAt =
        campaign.completedAt ??
        (campaign.status === 'COMPLETED'
          ? campaign.updatedAt
          : campaign.endsAt < now
            ? campaign.endsAt
            : now);
      // Another process may have billed it while this one waited for the lock.
      const claimed = await tx.campaign.updateMany({
        where: { id: campaignId, billedAt: null },
        data: {
          billedAt: now,
          status: 'COMPLETED',
          completedAt: finishedAt,
        },
      });
      if (claimed.count === 0) return null;

      const [totals] = await tx.$queryRaw<
        Array<{ impressions: bigint; clicks: bigint; cost: bigint }>
      >`
        SELECT COALESCE(SUM(impressions), 0)::bigint AS impressions,
               COALESCE(SUM(clicks), 0)::bigint AS clicks,
               COALESCE(SUM(cost_millicents), 0)::bigint AS cost
        FROM metrics WHERE campaign_id = ${campaignId}
      `;
      const subtotalCents = Math.round(Number(totals?.cost ?? 0n) / 1000);
      if (subtotalCents === 0) return null;

      const filtered = await tx.filteredEvent.aggregate({
        where: { campaignId },
        _sum: { count: true },
      });
      const year = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: env.PLATFORM_TIMEZONE,
          year: 'numeric',
        }).format(now),
      );
      const [sequence] = await tx.$queryRaw<Array<{ last: number }>>`
        INSERT INTO invoice_sequences (year, last) VALUES (${year}, 1)
        ON CONFLICT (year) DO UPDATE SET last = invoice_sequences.last + 1
        RETURNING last
      `;
      const number = `INV-${year}-${String(sequence?.last ?? 1).padStart(5, '0')}`;

      const created = await tx.invoice.create({
        data: {
          number,
          organisationId: campaign.organisationId,
          campaignId,
          organisationName: campaign.organisation.name,
          campaignTitle: campaign.title,
          advertiser: campaign.advertiser,
          periodStart: campaign.startsAt,
          periodEnd: finishedAt,
          impressions: Number(totals?.impressions ?? 0n),
          clicks: Number(totals?.clicks ?? 0n),
          filteredEvents: filtered._sum.count ?? 0,
          subtotalCents,
          totalCents: subtotalCents,
          issuedAt: now,
        },
      });
      await tx.balanceEntry.create({
        data: {
          organisationId: campaign.organisationId,
          kind: 'CHARGE',
          amountCents: -created.totalCents,
          description: `Invoice ${number}: ${campaign.title}`,
          invoiceId: created.id,
          createdAt: now,
        },
      });
      return created;
    });

    decisionCache.invalidate();
    if (invoice)
      await this.sendInvoice(invoice).catch((error: unknown) =>
        console.error(`Invoice email for ${invoice.number} failed:`, String(error)),
      );
    return invoice;
  }

  /** Bills every campaign whose delivery is final. Run by the scheduler. */
  async run(now = new Date()): Promise<number> {
    let issued = 0;
    for (const id of await this.settledCampaigns(now)) {
      if (await this.issueInvoice(id, now)) issued += 1;
    }
    return issued;
  }

  private async sendInvoice(invoice: Invoice): Promise<void> {
    const owners = await prisma.membership.findMany({
      where: { organisationId: invoice.organisationId, role: 'OWNER', user: { suspendedAt: null } },
      include: { user: { select: { email: true } } },
    });
    if (owners.length === 0) return;
    const [pdf, account] = await Promise.all([
      invoicePdf(invoice),
      this.account(invoice.organisationId),
    ]);
    for (const { user } of owners) {
      await deliverEmail({
        to: user.email,
        subject: `Invoice ${invoice.number}: ${invoice.campaignTitle}`,
        body: `Invoice ${invoice.number} for “${invoice.campaignTitle}”: ${formatEuros(invoice.totalCents)} for ${invoice.impressions.toLocaleString('en-GB')} impressions, paid from your prepaid balance.\n\nBalance now: ${formatEuros(account.balanceCents)}, of which ${formatEuros(account.availableCents)} is available for new campaigns.\n\nThe invoice is attached as a PDF.`,
        link: `${env.APP_URL}/#/billing`,
        attachments: [
          { filename: `${invoice.number}.pdf`, contentType: 'application/pdf', content: pdf },
        ],
      });
    }
  }

  /** The billing page: balance, what running campaigns hold, history and invoices. */
  async overview(actor: Actor): Promise<Overview> {
    if (!actor.organisationId || !canManageCampaigns(actor)) {
      throw new AppError(403, 'Billing is for owners and managers.');
    }
    const organisationId = actor.organisationId;
    const [account, entries, invoices] = await Promise.all([
      this.account(organisationId),
      prisma.balanceEntry.findMany({
        where: { organisationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          kind: true,
          amountCents: true,
          description: true,
          createdAt: true,
          invoiceId: true,
        },
      }),
      prisma.invoice.findMany({
        where: { organisationId },
        orderBy: { issuedAt: 'desc' },
        take: 50,
      }),
    ]);
    return { ...account, entries, invoices };
  }

  /** An invoice the actor may see: their own organisation's, or any for an admin. */
  async invoiceFor(actor: Actor, id: string): Promise<Invoice> {
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    const allowed =
      invoice &&
      (actor.role === 'ADMIN' ||
        (canManageCampaigns(actor) && actor.organisationId === invoice.organisationId));
    if (!invoice || !allowed) throw new AppError(404, 'Invoice not found.');
    return invoice;
  }

  /** Every organisation's balance, for platform admins. */
  async organisations(): Promise<OrganisationAccount[]> {
    const organisations = await prisma.organisation.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, _count: { select: { invoices: true } } },
    });
    return Promise.all(
      organisations.map(async ({ id, name, _count }) => ({
        id,
        name,
        invoices: _count.invoices,
        ...(await this.account(id)),
      })),
    );
  }

  /**
   * What the platform earned as the publisher: delivered ad revenue in a period, split
   * by show, advertiser and ad slot, beside what was invoiced and paid in.
   */
  async revenue({ from, to }: DateRange): Promise<Revenue> {
    const inRange = Prisma.sql`m.bucket >= ${from} AND m.bucket < ${to}`;
    const cents = Prisma.sql`ROUND(COALESCE(SUM(m.cost_millicents), 0) / 1000.0)::bigint`;
    const [totals, byShow, byOrganisation, bySlot, invoiced, credits, unbilled] = await Promise.all(
      [
        prisma.$queryRaw<Array<{ impressions: bigint; revenue: bigint }>>`
          SELECT COALESCE(SUM(m.impressions), 0)::bigint AS impressions, ${cents} AS revenue
          FROM metrics m WHERE ${inRange}`,
        prisma.$queryRaw<
          Array<{ label: string; genre: string; impressions: bigint; revenue: bigint }>
        >`
          SELECT s.title AS label, s.genre, SUM(m.impressions)::bigint AS impressions, ${cents} AS revenue
          FROM metrics m JOIN shows s ON s.id = m.show_id WHERE ${inRange}
          GROUP BY s.title, s.genre ORDER BY revenue DESC`,
        prisma.$queryRaw<Array<{ label: string; impressions: bigint; revenue: bigint }>>`
          SELECT o.name AS label, SUM(m.impressions)::bigint AS impressions, ${cents} AS revenue
          FROM metrics m JOIN campaigns c ON c.id = m.campaign_id
          JOIN organisations o ON o.id = c.organisation_id WHERE ${inRange}
          GROUP BY o.name ORDER BY revenue DESC`,
        prisma.$queryRaw<Array<{ label: string; impressions: bigint; revenue: bigint }>>`
          SELECT m.slot::text AS label, SUM(m.impressions)::bigint AS impressions, ${cents} AS revenue
          FROM metrics m WHERE ${inRange} GROUP BY m.slot ORDER BY revenue DESC`,
        prisma.invoice.aggregate({
          where: { issuedAt: { gte: from, lt: to } },
          _sum: { totalCents: true },
          _count: true,
        }),
        prisma.balanceEntry.aggregate({
          where: { kind: 'CREDIT', createdAt: { gte: from, lt: to } },
          _sum: { amountCents: true },
        }),
        prisma.$queryRaw<Array<{ revenue: bigint }>>`
          SELECT ${cents} AS revenue FROM metrics m
          JOIN campaigns c ON c.id = m.campaign_id WHERE c.billed_at IS NULL`,
      ],
    );

    const rows = (
      list: Array<{ label: string; impressions: bigint; revenue: bigint; genre?: string }>,
    ): RevenueRow[] =>
      list.map(({ label, impressions, revenue, genre }) => ({
        label,
        ...(genre ? { genre } : {}),
        impressions: Number(impressions),
        revenueCents: Number(revenue),
        // What 1,000 impressions earned.
        ecpmCents:
          Number(impressions) > 0 ? Math.round((Number(revenue) / Number(impressions)) * 1000) : 0,
      }));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      impressions: Number(totals[0]?.impressions ?? 0n),
      revenueCents: Number(totals[0]?.revenue ?? 0n),
      invoicedCents: invoiced._sum.totalCents ?? 0,
      invoiceCount: invoiced._count,
      creditsCents: credits._sum.amountCents ?? 0,
      unbilledCents: Number(unbilled[0]?.revenue ?? 0n),
      byShow: rows(byShow),
      byOrganisation: rows(byOrganisation),
      bySlot: rows(bySlot),
    };
  }
}

export const billingService = new BillingService();
