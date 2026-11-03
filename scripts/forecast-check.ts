/**
 * scripts/forecast-check.ts
 *
 * Backtest: hides the last 7 days of recorded inventory, forecasts them from the
 * weeks before, and compares the two. Run via: npm run forecast:check
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createCampaignSchema } from '@/modules/campaigns/campaigns.schema';
import { forecastCampaign } from '@/modules/campaigns/forecast.service';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HOLDOUT_DAYS = 7;
const ACCURACY_TARGET = 0.15;

const TARGETS: Array<{ name: string; targeting: object }> = [
  { name: 'Everything', targeting: {} },
  { name: 'Germany', targeting: { targetCountries: ['DE'] } },
  { name: 'Sports', targeting: { targetGenres: ['Sports'] } },
  { name: 'Connected TV', targeting: { targetDevices: ['CTV'] } },
  {
    name: 'Pre-roll on mobile',
    targeting: { targetSlots: ['PRE_ROLL'], targetDevices: ['MOBILE'] },
  },
  { name: 'Evenings, 18:00 to 22:59', targeting: { activeHours: [18, 19, 20, 21, 22] } },
  { name: 'Weekends', targeting: { activeDays: [0, 6] } },
  { name: 'Drama in France', targeting: { targetGenres: ['Drama'], targetCountries: ['FR'] } },
];

const actualRequests = async (from: Date, to: Date, targeting: Record<string, unknown>) => {
  const list = (key: string): string[] => (targeting[key] as string[] | undefined) ?? [];
  const within = (column: string, values: string[]): Prisma.Sql =>
    values.length > 0
      ? Prisma.sql`${Prisma.raw(`${column}::text`)} = ANY(${values}::text[])`
      : Prisma.sql`TRUE`;

  const hours = (targeting['activeHours'] as number[] | undefined) ?? [];
  const days = (targeting['activeDays'] as number[] | undefined) ?? [];
  const local = Prisma.sql`bucket AT TIME ZONE 'Europe/Berlin'`;

  const rows = await prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(requests), 0) AS total
    FROM inventory_hours
    WHERE bucket >= ${from} AND bucket < ${to}
      AND ${within('genre', list('targetGenres'))}
      AND ${within('country', list('targetCountries'))}
      AND ${within('slot', list('targetSlots'))}
      AND ${within('device', list('targetDevices'))}
      AND (${hours.length === 0} OR EXTRACT(HOUR FROM ${local})::int = ANY(${hours}::int[]))
      AND (${days.length === 0} OR EXTRACT(DOW FROM ${local})::int = ANY(${days}::int[]))
  `);
  return Number(rows[0]?.total ?? 0);
};

async function main(): Promise<void> {
  const latest = await prisma.inventoryHour.aggregate({ _max: { bucket: true } });
  if (!latest._max.bucket) throw new Error('No inventory. Run: npm run db:seed');

  const end = Math.floor(latest._max.bucket.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  const startsAt = new Date(end - HOLDOUT_DAYS * DAY_MS);
  const endsAt = new Date(end);

  const results: Array<{ name: string; forecast: number; actual: number; error: number }> = [];

  for (const { name, targeting } of TARGETS) {
    const dto = createCampaignSchema.parse({
      title: 'Backtest',
      advertiser: 'Backtest',
      budgetCents: 2_000_000_000,
      cpmCents: 1,
      impressionGoal: 2_000_000_000,
      startsAt,
      endsAt,
      deliveryType: 'AUCTION',
      ...targeting,
    });

    const { availableImpressions } = await forecastCampaign(dto, {
      asOf: startsAt.getTime(),
    });
    const actual = await actualRequests(startsAt, endsAt, targeting as Record<string, unknown>);
    results.push({
      name,
      forecast: availableImpressions,
      actual,
      error: Math.abs(availableImpressions - actual) / actual,
    });
  }

  const width = Math.max(...results.map(({ name }) => name.length));
  console.info(
    `${'Targeting'.padEnd(width)}  ${'Forecast'.padStart(12)}  ${'Actual'.padStart(12)}  Error`,
  );
  for (const { name, forecast, actual, error } of results) {
    console.info(
      `${name.padEnd(width)}  ${forecast.toLocaleString('en').padStart(12)}  ${actual
        .toLocaleString('en')
        .padStart(12)}  ${(error * 100).toFixed(1)}%`,
    );
  }

  const average = results.reduce((sum, { error }) => sum + error, 0) / results.length;
  const worst = Math.max(...results.map(({ error }) => error));
  console.info(
    `\nAverage error ${(average * 100).toFixed(1)}%, worst ${(worst * 100).toFixed(1)}%`,
  );

  await prisma.$disconnect();
  if (worst > ACCURACY_TARGET) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
