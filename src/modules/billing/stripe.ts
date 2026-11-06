/**
 * src/modules/billing/stripe.ts
 *
 * Optional card payments through Stripe Checkout, with the runner's own Stripe
 * account (test mode needs no real money). Without STRIPE_SECRET_KEY, this is off
 * and platform admins add credit by hand.
 *
 * A payment is credited once it's paid, in either of two ways, whichever comes first:
 * Stripe's webhook, or the page asking the server to check when the payer comes back.
 * The second needs no public address, so card payments work on a laptop too. Each
 * Checkout Session can be credited only once.
 */
import type { BalanceEntry } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { CURRENCIES, rateFor, toEuros } from './currency';

let client: Stripe | null | undefined;

/** Tests point this at a local stand-in for Stripe. */
export const setStripeClient = (stripe: Stripe | null | undefined): void => {
  client = stripe;
};

export const stripe = (): Stripe | null => {
  if (client !== undefined) return client;
  client = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
  return client;
};

export const checkoutSchema = z.object({
  /** In the organisation's currency, in cents. */
  amountCents: z
    .number({ error: 'Enter an amount.' })
    .int()
    .min(1000, { error: 'The smallest top-up is 10.00.' })
    .max(10_000_000, { error: 'The largest top-up by card is 100,000.00.' }),
});

const requireStripe = (): Stripe => {
  const stripeClient = stripe();
  if (!stripeClient) {
    throw new AppError(503, 'Card payments are off. A platform admin can add credit instead.');
  }
  return stripeClient;
};

/** Starts a card payment and returns Stripe's page to send the payer to. */
export const createCheckout = async (
  organisationId: string,
  userId: string,
  amountCents: number,
): Promise<{ url: string; id: string }> => {
  const stripeClient = requireStripe();
  const organisation = await prisma.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: { name: true, currency: true },
  });
  const session = await stripeClient.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: organisation.currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: `Prepaid advertising credit for ${organisation.name}` },
        },
      },
    ],
    metadata: { organisationId, userId },
    success_url: `${env.APP_URL}/#/billing?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_URL}/#/billing`,
  });
  if (!session.url) throw new AppError(502, 'Stripe did not return a payment page.');
  return { url: session.url, id: session.id };
};

/**
 * Adds a paid Checkout Session to the balance, converted to euros at the day's rate.
 * Returns the new entry, or null when it isn't paid yet or was already credited.
 */
export const creditSession = async (
  session: Stripe.Checkout.Session,
): Promise<BalanceEntry | null> => {
  const organisationId = session.metadata?.['organisationId'];
  if (!organisationId || session.payment_status !== 'paid' || !session.amount_total) return null;
  const currency = (session.currency ?? 'eur').toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(currency)) return null;

  const existing = await prisma.balanceEntry.findUnique({ where: { stripeSessionId: session.id } });
  if (existing) return null;

  const { rate } = await rateFor(currency);
  const amountCents = toEuros(session.amount_total, rate);
  const paid = `${(session.amount_total / 100).toFixed(2)} ${currency}`;
  try {
    return await prisma.balanceEntry.create({
      data: {
        organisationId,
        kind: 'CREDIT',
        amountCents,
        description: currency === 'EUR' ? 'Card payment' : `Card payment: ${paid}`,
        stripeSessionId: session.id,
        paidCents: session.amount_total,
        paidCurrency: currency,
        createdById: session.metadata?.['userId'] ?? null,
      },
    });
  } catch (error) {
    // The webhook and the page arrived at the same moment; the other one credited it.
    if ((error as { code?: string }).code === 'P2002') return null;
    throw error;
  }
};

/** The page's check when the payer comes back from Stripe. */
export const confirmCheckout = async (
  organisationId: string,
  sessionId: string,
): Promise<{ paid: boolean; entry: BalanceEntry | null }> => {
  const session = await requireStripe().checkout.sessions.retrieve(sessionId);
  if (session.metadata?.['organisationId'] !== organisationId) {
    throw new AppError(404, 'Payment not found.');
  }
  const entry =
    (await creditSession(session)) ??
    (await prisma.balanceEntry.findUnique({ where: { stripeSessionId: sessionId } }));
  return { paid: session.payment_status === 'paid', entry };
};

/** Stripe's webhook: verifies the signature, then credits a completed payment. */
export const handleWebhook = async (payload: Buffer, signature: string): Promise<void> => {
  const stripeClient = requireStripe();
  if (!env.STRIPE_WEBHOOK_SECRET) throw new AppError(503, 'The Stripe webhook is not set up.');
  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, 'The webhook signature is not valid.');
  }
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    await creditSession(event.data.object);
  }
};
