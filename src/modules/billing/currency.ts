/**
 * src/modules/billing/currency.ts
 *
 * Prices, budgets and the balance are in euros, the platform's currency. An
 * organisation can pay and be invoiced in another currency, converted at the
 * European Central Bank's daily reference rate: free, public, and the usual basis for
 * invoices in the EU. Rates are stored, so an invoice can always show the one it used.
 */
import { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

/** Currencies an organisation can choose. The ECB publishes a rate for each one. */
export const CURRENCIES = ['EUR', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Rate {
  currency: string;
  /** 1 EUR = rate units of the currency. */
  rate: number;
  /** The ECB's date for the rate. */
  date: string;
}

/** Reads the ECB's daily file: <Cube time="2026-11-05"> holding <Cube currency="GBP" rate="0.8612"/>. */
export const parseEcbRates = (xml: string): { date: string; rates: Map<string, number> } => {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) throw new Error('The ECB file had no date.');
  const rates = new Map<string, number>();
  for (const [, currency, rate] of xml.matchAll(
    /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
  )) {
    if (currency && rate) rates.set(currency, Number(rate));
  }
  if (rates.size === 0) throw new Error('The ECB file had no rates.');
  return { date, rates };
};

/** Fetches today's rates and stores them. Run by the scheduler; a failure keeps the last ones. */
export const refreshRates = async (): Promise<number> => {
  const response = await fetch(env.ECB_RATES_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The ECB returned ${response.status}.`);
  const { date, rates } = parseEcbRates(await response.text());
  const rows = CURRENCIES.filter((currency) => currency !== 'EUR' && rates.has(currency)).map(
    (currency) => ({
      date: new Date(`${date}T00:00:00Z`),
      currency,
      rate: rates.get(currency) ?? 0,
    }),
  );
  await prisma.$transaction(
    rows.map((row) =>
      prisma.exchangeRate.upsert({
        where: { date_currency: { date: row.date, currency: row.currency } },
        create: row,
        update: { rate: row.rate },
      }),
    ),
  );
  return rows.length;
};

/** The latest rate on or before a moment. Euros are always 1. */
export const rateFor = async (currency: string, at = new Date()): Promise<Rate> => {
  if (currency === 'EUR') return { currency, rate: 1, date: at.toISOString().slice(0, 10) };
  const row = await prisma.exchangeRate.findFirst({
    where: { currency, date: { lte: at } },
    orderBy: { date: 'desc' },
  });
  if (!row) {
    throw new AppError(
      503,
      `There's no exchange rate for ${currency} yet. The platform fetches them daily from the European Central Bank.`,
    );
  }
  return { currency, rate: Number(row.rate), date: row.date.toISOString().slice(0, 10) };
};

/** Euros to another currency, to the cent. */
export const fromEuros = (eurCents: number, rate: number): number => Math.round(eurCents * rate);

/** Another currency to euros, to the cent. */
export const toEuros = (cents: number, rate: number): number => Math.round(cents / rate);

export const decimal = (value: number): Prisma.Decimal => new Prisma.Decimal(value);
