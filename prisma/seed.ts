/**
 * prisma/seed.ts
 *
 * Seeds a fictional streaming ad business: users, shows, campaigns in different
 * states, and 30 days of hourly metrics. Run via: npm run db:seed
 * With --if-empty it leaves an existing database alone. With --if-stale it also
 * refreshes data older than a week, which keeps the public demo's dates current.
 *
 * In demo mode only the guest account has a known password.
 */
import {
  PrismaClient,
  Role,
  OrganisationRole,
  CampaignStatus,
  CreativeStatus,
  DeliveryType,
  PacingMode,
  AdSlot,
  Device,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import {
  AD_LENGTH,
  EPISODE_LENGTH,
  clearDemoMedia,
  makeDemoVideos,
  mediaFileSize,
  type DemoVideo,
} from './demo-media';

const prisma = new PrismaClient();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Seeded reach: viewers see an ad about 2.5 times a day, and each campaign's viewers
// come from a pool four times its busiest day.
const DAILY_FREQUENCY = 2.5;
const MAX_DAILY_VIEWERS = 40_000;
const POOL_DAYS = 4;
const SHARED_VIEWER_SHARE = 0.3;
const COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'NL', 'AT', 'SE'];
const DEVICES = [Device.CTV, Device.CTV, Device.CTV, Device.MOBILE, Device.WEB, Device.TABLET];
const SLOTS = [AdSlot.PRE_ROLL, AdSlot.MID_ROLL, AdSlot.MID_ROLL, AdSlot.POST_ROLL];
const CLICK_RATE: Record<Device, number> = { CTV: 0.003, MOBILE: 0.02, WEB: 0.014, TABLET: 0.011 };
const COMPLETION_RATE: Record<AdSlot, number> = { PRE_ROLL: 0.78, MID_ROLL: 0.93, POST_ROLL: 0.55 };

const SHOWS = [
  { title: 'Harbour Lights', genre: 'Drama' },
  { title: 'The Alpine Files', genre: 'Crime' },
  { title: 'Kitchen Rivals', genre: 'Reality' },
  { title: 'Matchday Live', genre: 'Sports' },
  { title: 'Northern Skies', genre: 'Documentary' },
  { title: 'Little Explorers', genre: 'Kids' },
];

// Fictional advertisers. Delivery is how far along the impression goal the seed leaves them.
const CAMPAIGNS = [
  {
    title: 'Winter Coats Launch',
    advertiser: 'Nordkap Outdoor',
    cpm: 1800,
    budget: 9_000_000,
    goal: 5_000_000,
    from: -20,
    to: 25,
    delivery: 0.44,
    countries: ['DE', 'AT', 'SE'],
    genres: [],
    devices: [],
    slots: [],
  },
  {
    title: 'Electric City Car',
    advertiser: 'Volta Motors',
    cpm: 3200,
    budget: 19_200_000,
    goal: 6_000_000,
    from: -14,
    to: 16,
    delivery: 0.3,
    countries: ['DE', 'FR', 'NL'],
    genres: ['Drama', 'Crime', 'Documentary'],
    devices: [Device.CTV],
    slots: [AdSlot.PRE_ROLL, AdSlot.MID_ROLL],
  },
  {
    title: 'Matchday Fan Bundle',
    advertiser: 'Goal Telecom',
    cpm: 2600,
    budget: 10_400_000,
    goal: 4_000_000,
    from: -10,
    to: 20,
    delivery: 0.42,
    countries: [],
    genres: ['Sports'],
    devices: [],
    slots: [AdSlot.MID_ROLL],
  },
  {
    title: 'Family Breakfast',
    advertiser: 'Sonnenhof Foods',
    cpm: 1400,
    budget: 4_200_000,
    goal: 3_000_000,
    from: -25,
    to: 5,
    delivery: 0.6,
    countries: ['DE', 'AT'],
    genres: ['Kids', 'Reality'],
    devices: [],
    slots: [],
  },
  {
    title: 'Mediterranean Escapes',
    advertiser: 'Azul Travel',
    cpm: 2200,
    budget: 6_600_000,
    goal: 3_000_000,
    from: -9,
    to: 40,
    delivery: 0.22,
    countries: ['IT', 'ES', 'FR'],
    genres: [],
    devices: [],
    slots: [AdSlot.PRE_ROLL],
  },
  {
    title: 'Spring Teaser',
    advertiser: 'Nordkap Outdoor',
    cpm: 1600,
    budget: 3_200_000,
    goal: 2_000_000,
    from: -6,
    to: 30,
    delivery: 0.1,
    countries: [],
    genres: [],
    devices: [],
    slots: [],
    status: CampaignStatus.PAUSED,
  },
  {
    title: 'Autumn Sale',
    advertiser: 'Casa Mobili',
    cpm: 1500,
    budget: 3_000_000,
    goal: 2_000_000,
    from: -30,
    to: -4,
    delivery: 1,
    countries: ['IT', 'ES'],
    genres: [],
    devices: [],
    slots: [],
    status: CampaignStatus.COMPLETED,
  },
];

/** Delivery rules that show what the platform can do. */
const RULES: Record<string, Partial<Prisma.CampaignUncheckedCreateInput>> = {
  'Electric City Car': {
    pacingMode: PacingMode.EVEN,
    frequencyCapPerDay: 3,
    competitiveCategory: 'Automotive',
  },
  'Matchday Fan Bundle': { pacingMode: PacingMode.EVEN, competitiveCategory: 'Telecoms' },
  'Family Breakfast': { activeHours: [6, 7, 8, 9, 10, 11], dailyBudgetCents: 40_000 },
  'Mediterranean Escapes': { deliveryType: DeliveryType.AUCTION },
  'Winter Coats Launch': { pacingMode: PacingMode.CUSTOM, dailyImpressionTarget: 150_000 },
};

/** Small seeded generator, so every seed produces the same demo story. */
const createRandom = (seed: number) => (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** Evening prime time, with a smaller lunchtime bump. */
const audienceAt = (hour: number): number =>
  0.12 + Math.exp(-((hour - 20.5) ** 2) / 8) + 0.3 * Math.exp(-((hour - 12.5) ** 2) / 6);

const SHOW_COLOURS: Array<[string, string]> = [
  ['0x10324f', '0x1f6f8b'],
  ['0x2b1f3d', '0x6a3d8f'],
  ['0x4a2410', '0xb5651d'],
  ['0x0f3d2e', '0x2e8b57'],
  ['0x1b2a49', '0x465881'],
  ['0x5b1e3c', '0xc2477f'],
];

const AD_COLOURS: Array<[string, string]> = [
  ['0x1c5cab', '0x3987e5'],
  ['0xb5401a', '0xeb6834'],
  ['0x0f7a56', '0x1baf7a'],
  ['0x8a5b00', '0xeda100'],
  ['0x3f2fa3', '0x6250d6'],
  ['0x9c2f2f', '0xe34948'],
];

interface DemoAd {
  campaignId: string;
  advertiser: string;
  title: string;
  userId: string;
}

/**
 * Four weeks of hourly ad requests, in one statement. Forecasts read this history,
 * so it behaves like real traffic: evening peaks and busier weekends, slow growth,
 * days that run hot or cold, and big sports nights nobody can predict.
 */
async function createInventory(): Promise<void> {
  await prisma.$transaction([
    prisma.$queryRaw`SELECT setseed(0.42)::text`,
    prisma.$executeRaw`
      WITH days AS MATERIALIZED (
        SELECT day::date,
          (0.85 + random() * 0.3) * (1 + 0.006 * (day::date - (now()::date - 29))) AS level,
          CASE WHEN random() < 0.3 THEN 2.2 ELSE 1 END AS big_match
        FROM generate_series(now()::date - 29, now()::date + 1, interval '1 day') AS day
      )
      INSERT INTO inventory_hours (bucket, genre, slot, country, device, requests)
      SELECT h.bucket, g.name, s.name::"AdSlot", c.name, d.name::"Device",
        GREATEST(1, round(
          170000 * g.share * s.share * c.share * d.share * today.level
            * (0.12 + exp(-((local.hour - 20.5) ^ 2) / 8) + 0.3 * exp(-((local.hour - 12.5) ^ 2) / 6))
            * CASE WHEN local.weekday IN (0, 6) THEN 1.25 ELSE 1 END
            * CASE WHEN g.name = 'Sports' AND local.hour BETWEEN 18 AND 22
                THEN today.big_match ELSE 1 END
            * (0.94 + random() * 0.12)
        ))::int
      FROM generate_series(
        date_trunc('hour', now()) - interval '28 days',
        date_trunc('hour', now()) - interval '1 hour',
        interval '1 hour'
      ) AS h(bucket)
      CROSS JOIN LATERAL (
        SELECT EXTRACT(HOUR FROM h.bucket AT TIME ZONE 'Europe/Berlin')::float AS hour,
          EXTRACT(DOW FROM h.bucket AT TIME ZONE 'Europe/Berlin')::int AS weekday
      ) AS local
      JOIN days AS today ON today.day = (h.bucket AT TIME ZONE 'Europe/Berlin')::date
      CROSS JOIN (VALUES
        ('Drama', 0.3), ('Crime', 0.2), ('Reality', 0.15),
        ('Sports', 0.2), ('Documentary', 0.05), ('Kids', 0.1)
      ) AS g(name, share)
      CROSS JOIN (VALUES ('PRE_ROLL', 0.35), ('MID_ROLL', 0.5), ('POST_ROLL', 0.15)) AS s(name, share)
      CROSS JOIN (VALUES
        ('DE', 0.35), ('FR', 0.2), ('IT', 0.15), ('ES', 0.12), ('NL', 0.08), ('AT', 0.06), ('SE', 0.04)
      ) AS c(name, share)
      CROSS JOIN (VALUES ('CTV', 0.5), ('MOBILE', 0.3), ('WEB', 0.15), ('TABLET', 0.05)) AS d(name, share)
    `,
  ]);

  await prisma.audienceDay.createMany({
    data: Array.from({ length: 28 }, (_, index) => ({
      day: new Date(Date.now() - index * DAY).toISOString().slice(0, 10),
      viewers: 420_000,
      consented: 294_000,
      allTime: 1_900_000,
    })),
  });
}

/** Makes the videos, then links them to shows and approved ads. One waits for review. */
async function createDemoMedia(
  shows: Array<{ id: string; title: string; genre: string }>,
  ads: DemoAd[],
): Promise<void> {
  console.info('Making demo videos...');
  await clearDemoMedia();

  const videos: DemoVideo[] = shows.map((show, index) => ({
    key: `shows/${show.id}/episode.mp4`,
    title: show.title,
    subtitle: `${show.genre} - Episode 1`,
    colours: SHOW_COLOURS[index % SHOW_COLOURS.length] as [string, string],
    seconds: EPISODE_LENGTH,
    tone: 110,
  }));

  const adRows = ads.flatMap((ad, index) => {
    const entries = [{ ...ad, label: ad.title, status: CreativeStatus.APPROVED }];
    if (index === 0) {
      entries.push({
        ...ad,
        label: `${ad.title} (short cut)`,
        status: CreativeStatus.PENDING_REVIEW,
      });
    }
    if (ad.title === 'Matchday Fan Bundle') {
      entries.push({ ...ad, label: `${ad.title} (version B)`, status: CreativeStatus.APPROVED });
    }
    return entries;
  });

  const creatives = adRows.map((ad, index) => ({
    ...ad,
    id: `demo-ad-${index + 1}`,
    colours: AD_COLOURS[index % AD_COLOURS.length] as [string, string],
  }));

  videos.push(
    ...creatives.map((ad) => ({
      key: `creatives/${ad.id}/video.mp4`,
      title: ad.advertiser,
      subtitle: `${ad.label} - fictional ad`,
      colours: ad.colours,
      seconds: AD_LENGTH,
      tone: 220,
    })),
  );

  await makeDemoVideos(videos);

  await Promise.all(
    shows.map((show) =>
      prisma.show.update({
        where: { id: show.id },
        data: { videoKey: `shows/${show.id}/episode.mp4` },
      }),
    ),
  );

  await prisma.creative.createMany({
    data: creatives.map((ad) => ({
      id: ad.id,
      campaignId: ad.campaignId,
      createdById: ad.userId,
      name: ad.label,
      clickUrl: 'https://example.com/offer',
      status: ad.status,
      videoKey: `creatives/${ad.id}/video.mp4`,
      posterKey: `creatives/${ad.id}/poster.jpg`,
      durationSeconds: AD_LENGTH,
      width: 854,
      height: 480,
      sizeBytes: mediaFileSize(`creatives/${ad.id}/video.mp4`),
    })),
  });

  // A finished A/B test, so the comparison has something to show.
  const [versionA, versionB] = creatives.filter(({ title }) => title === 'Matchday Fan Bundle');
  if (versionA && versionB) {
    const bucket = new Date(Math.floor(Date.now() / HOUR - 24) * HOUR);
    await prisma.creativeMetric.createMany({
      data: [
        {
          creativeId: versionA.id,
          bucket,
          impressions: 120_000,
          clicks: 1100,
          completions: 104_000,
        },
        {
          creativeId: versionB.id,
          bucket,
          impressions: 118_000,
          clicks: 1420,
          completions: 103_000,
        },
      ],
    });
  }
}

/**
 * Daily reach sketches for the seeded history, so reach and frequency have something
 * to show. Each campaign draws its viewers from its own pool, so the same people come
 * back on different days, plus a shared pool so some viewers see several campaigns.
 * Viewer IDs are made up.
 */
async function createReach(
  rows: Prisma.MetricCreateManyInput[],
  random: () => number,
): Promise<void> {
  const daily = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = new Date(row.bucket).toISOString().slice(0, 10);
    const days = daily.get(row.campaignId) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + (row.impressions ?? 0));
    daily.set(row.campaignId, days);
  }

  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  for (const [campaignId, days] of daily) {
    const viewersByDay = new Map(
      [...days].map(([day, impressions]) => [
        day,
        Math.min(MAX_DAILY_VIEWERS, Math.round(impressions / DAILY_FREQUENCY)),
      ]),
    );
    const pool = Math.max(1, Math.max(...viewersByDay.values()) * POOL_DAYS);

    for (const [day, viewers] of viewersByDay) {
      const pipeline = redis.pipeline();
      for (let start = 0; start < viewers; start += 1000) {
        const ids = Array.from(
          { length: Math.min(1000, viewers - start) },
          // Some viewers watch several campaigns' shows, most only this one's.
          // Hashed the same way as the event script, which uses redis.sha1hex.
          () =>
            createHash('sha1')
              .update(
                random() < SHARED_VIEWER_SHARE
                  ? `seed-viewer-shared-${Math.floor(random() * pool)}`
                  : `seed-viewer-${campaignId}-${Math.floor(random() * pool)}`,
              )
              .digest('hex'),
        );
        pipeline.pfadd(`reach:${campaignId}:${day}`, ...ids);
        pipeline.pfadd(`reach:${campaignId}`, ...ids);
      }
      pipeline.expire(`reach:${campaignId}:${day}`, 400 * 24 * 3600);
      await pipeline.exec();
    }
  }
  redis.disconnect();
}

/** The next time it's this hour on this weekday in Berlin, for the demo report's schedule. */
const nextWeekdayAt = (weekday: number, hour: number): Date => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env['PLATFORM_TIMEZONE'] ?? 'Europe/Berlin',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  let time = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
  for (let step = 0; step < 8 * 24; step += 1, time += HOUR) {
    const local = parts.formatToParts(time);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      local.find((part) => part.type === 'weekday')?.value ?? '',
    );
    if (day === weekday && Number(local.find((part) => part.type === 'hour')?.value) === hour) {
      break;
    }
  }
  return new Date(time);
};

/** Queued events and counters belong to the data being replaced. */
async function clearLiveCounters(): Promise<void> {
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  await redis.flushdb();
  redis.disconnect();
}

async function main(): Promise<void> {
  const isDemo = process.env['DEMO_MODE'] === 'true';
  if (process.env['NODE_ENV'] === 'production' && !isDemo) {
    throw new Error('Refusing to seed production.');
  }
  if (
    process.argv.includes('--if-empty') &&
    (await prisma.user.count({ where: { email: 'analyst@example.com' } })) > 0
  ) {
    return;
  }
  if (process.argv.includes('--if-stale')) {
    const recent = await prisma.campaign.count({
      where: { createdAt: { gt: new Date(Date.now() - 7 * DAY) } },
    });
    if (recent > 0) return;
  }

  const password = (demoPassword: string): Promise<string> =>
    bcrypt.hash(isDemo ? randomBytes(24).toString('hex') : demoPassword, 12);

  console.info('Seeding demo data...');
  await clearLiveCounters();
  await prisma.metric.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.show.deleteMany();
  await prisma.organisation.deleteMany();
  await prisma.invoiceSequence.deleteMany();
  await prisma.user.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.inventoryHour.deleteMany();
  await prisma.audienceDay.deleteMany();
  await prisma.capturedEmail.deleteMany();

  const verified = new Date();

  const person = async (
    email: string,
    name: string,
    demoPassword: string,
    role: Role = Role.ADVERTISER,
  ): Promise<{ id: string }> =>
    prisma.user.create({
      data: {
        email,
        name,
        role,
        passwordHash: await password(demoPassword),
        emailVerifiedAt: verified,
      },
    });

  const owner = await person('advertiser@example.com', 'Olivia Owner', 'advert1234');
  const manager = await person('manager@example.com', 'Max Manager', 'manager1234');
  const analyst = await person('analyst@example.com', 'Anna Analyst', 'analyst1234');
  const rival = await person('rival@example.com', 'Rico Rival', 'rival1234');
  const admin = await person('admin@example.com', 'Ada Admin', 'admin1234', Role.ADMIN);

  const brightline = await prisma.organisation.create({
    data: {
      name: 'Brightline Media',
      // A German customer: invoices carry 19% VAT. All billing details are fictional.
      plan: 'GROWTH',
      billingName: 'Brightline Media GmbH',
      addressLine1: 'Musterweg 12',
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      vatId: 'DE000000001',
      memberships: {
        create: [
          { userId: owner.id, role: OrganisationRole.OWNER },
          { userId: manager.id, role: OrganisationRole.MANAGER },
          { userId: analyst.id, role: OrganisationRole.ANALYST },
        ],
      },
    },
  });
  const casa = await prisma.organisation.create({
    data: {
      name: 'Casa Creative',
      // An EU business with a confirmed VAT ID: the reverse charge, so no VAT on invoices.
      plan: 'STARTER',
      billingName: 'Casa Creative S.r.l.',
      addressLine1: 'Via Esempio 7',
      postalCode: '20121',
      city: 'Milano',
      country: 'IT',
      vatId: 'IT00000000001',
      vatIdVerifiedAt: new Date(),
      memberships: { create: { userId: rival.id, role: OrganisationRole.OWNER } },
    },
  });
  // Prepaid credit, paid in by bank transfer a month ago: enough for every demo
  // campaign's budget plus VAT where it applies, with room to start another.
  for (const [organisation, advertiser, vat] of [
    [brightline, null, 1.19],
    [casa, 'Casa Mobili', 1],
  ] as const) {
    const budgets = CAMPAIGNS.filter((spec) =>
      advertiser ? spec.advertiser === advertiser : spec.advertiser !== 'Casa Mobili',
    ).reduce((sum, spec) => sum + spec.budget, 0);
    await prisma.balanceEntry.create({
      data: {
        organisationId: organisation.id,
        kind: 'CREDIT',
        amountCents: Math.ceil((budgets * vat + 5_000_000) / 100_000) * 100_000,
        description: 'Bank transfer received',
        createdById: admin.id,
        createdAt: new Date(Date.now() - 31 * DAY),
      },
    });
  }
  await prisma.organisation.create({
    data: {
      name: 'Platform Team',
      plan: 'ENTERPRISE',
      memberships: { create: { userId: admin.id, role: OrganisationRole.OWNER } },
    },
  });

  await prisma.user.create({
    data: {
      email: 'guest@example.com',
      name: 'Guest',
      passwordHash: await bcrypt.hash('guest-demo', 12),
      role: Role.GUEST,
      emailVerifiedAt: verified,
    },
  });

  await prisma.show.createMany({ data: SHOWS });
  const shows = await prisma.show.findMany();
  const demoAds: Array<{ campaignId: string; advertiser: string; title: string; userId: string }> =
    [];

  const random = createRandom(42);
  const now = Date.now();
  const nowHour = Math.floor(now / HOUR) * HOUR;
  const rows: Prisma.MetricCreateManyInput[] = [];

  for (const spec of CAMPAIGNS) {
    const startsAt = new Date(now + spec.from * DAY);
    const endsAt = new Date(now + spec.to * DAY);
    const campaign = await prisma.campaign.create({
      data: {
        organisationId: spec.advertiser === 'Casa Mobili' ? casa.id : brightline.id,
        userId: spec.advertiser === 'Casa Mobili' ? rival.id : owner.id,
        title: spec.title,
        advertiser: spec.advertiser,
        status: spec.status ?? CampaignStatus.ACTIVE,
        budgetCents: spec.budget,
        cpmCents: spec.cpm,
        impressionGoal: spec.goal,
        startsAt,
        endsAt,
        targetCountries: spec.countries,
        targetGenres: spec.genres,
        targetDevices: spec.devices,
        targetSlots: spec.slots,
        // A finished campaign completed when its flight ended, so it's invoiced at startup.
        ...(spec.status === CampaignStatus.COMPLETED ? { completedAt: endsAt } : {}),
        ...RULES[spec.title],
      },
    });

    demoAds.push({
      campaignId: campaign.id,
      advertiser: spec.advertiser,
      title: spec.title,
      userId: campaign.userId,
    });

    const eligibleShows = shows.filter(
      (show) => spec.genres.length === 0 || spec.genres.includes(show.genre),
    );
    const countries = spec.countries.length > 0 ? spec.countries : COUNTRIES;
    const devices = spec.devices.length > 0 ? spec.devices : DEVICES;
    const slots = spec.slots.length > 0 ? spec.slots : SLOTS;

    const firstHour = Math.ceil(startsAt.getTime() / HOUR) * HOUR;
    const lastHour = Math.min(endsAt.getTime(), nowHour);
    const hours: number[] = [];
    for (let hour = firstHour; hour <= lastHour; hour += HOUR) hours.push(hour);

    const weights = hours.map((hour) => audienceAt(new Date(hour).getUTCHours()));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const delivered = spec.goal * spec.delivery;

    hours.forEach((hour, index) => {
      const hourImpressions = (delivered * (weights[index] as number)) / totalWeight;
      const merged = new Map<string, Prisma.MetricCreateManyInput>();

      // Each hour spreads over a handful of show, slot, country and device mixes.
      for (let mix = 0; mix < 4; mix += 1) {
        const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T;
        const show = pick(eligibleShows);
        const slot = pick(slots);
        const country = pick(countries);
        const device = pick(devices);
        const impressions = Math.round((hourImpressions / 4) * (0.7 + random() * 0.6));

        const key = [show.id, slot, country, device].join('|');
        const row = merged.get(key) ?? {
          campaignId: campaign.id,
          showId: show.id,
          slot,
          country,
          device,
          bucket: new Date(hour),
          impressions: 0,
          clicks: 0,
          completions: 0,
        };
        row.impressions = (row.impressions ?? 0) + impressions;
        row.clicks = (row.clicks ?? 0) + Math.round(impressions * CLICK_RATE[device]);
        row.costMillicents = Number(row.costMillicents ?? 0) + impressions * spec.cpm;
        const finished = COMPLETION_RATE[slot];
        row.firstQuartiles =
          (row.firstQuartiles ?? 0) + Math.round(impressions * Math.sqrt(Math.sqrt(finished)));
        row.midpoints = (row.midpoints ?? 0) + Math.round(impressions * Math.sqrt(finished));
        row.thirdQuartiles = (row.thirdQuartiles ?? 0) + Math.round(impressions * finished ** 0.75);
        row.completions = (row.completions ?? 0) + Math.round(impressions * COMPLETION_RATE[slot]);
        merged.set(key, row);
      }

      rows.push(...merged.values());
    });
  }

  for (let start = 0; start < rows.length; start += 5000) {
    await prisma.metric.createMany({ data: rows.slice(start, start + 5000) });
  }

  await prisma.audienceSegment.createMany({
    data: [
      { organisationId: brightline.id, name: 'Sports fans', genres: ['Sports'] },
      { organisationId: brightline.id, name: 'Families', genres: ['Kids', 'Reality'], minViews: 2 },
    ],
  });

  await createReach(rows, random);

  await prisma.report.create({
    data: {
      organisationId: brightline.id,
      createdById: owner.id,
      name: 'Weekly campaign summary',
      groupBy: 'CAMPAIGN',
      columns: [
        'impressions',
        'clicks',
        'ctr',
        'completionRate',
        'spend',
        'reach',
        'averageFrequency',
      ],
      rangeDays: 7,
      schedule: 'WEEKLY',
      sendWeekday: 1,
      sendHour: 8,
      recipientIds: [owner.id, analyst.id],
      nextRunAt: nextWeekdayAt(1, 8),
    },
  });

  await createInventory();
  if (!isDemo) await createDemoMedia(shows, demoAds);

  console.info(`Created ${CAMPAIGNS.length} campaigns and ${rows.length} hourly metric rows.`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
