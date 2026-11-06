/**
 * src/modules/billing/billing.routes.ts
 *
 * Prepaid balances and invoices. Owners and managers see their organisation's
 * billing; owners change billing details and pay by card. Platform admins add credit,
 * set plans, and see every balance and the revenue.
 */
import { Router, type Request, type Response } from 'express';
import { actorOf, contextOf, handle } from '@/lib/http';
import { authenticate, requirePlatformAdmin } from '@/middleware/authenticate';
import { auditService } from '@/modules/audit/audit.service';
import { dateRangeSchema } from '@/modules/campaigns/campaigns.schema';
import { AppError } from '@/middleware/errorHandler';
import { invoicePdf } from './billing.pdf';
import { billingService, creditSchema, detailsSchema, planSchema } from './billing.service';
import { checkoutSchema, confirmCheckout, createCheckout, handleWebhook } from './stripe';
import { logger } from '@/lib/logger';

/** Owners pay; managers can see billing but not spend the organisation's money. */
const ownerOf = (req: Request): { organisationId: string; userId: string } => {
  const actor = actorOf(req);
  if (!actor.organisationId || (actor.role !== 'ADMIN' && actor.organisationRole !== 'OWNER')) {
    throw new AppError(403, 'Only owners can pay for the organisation.');
  }
  return { organisationId: actor.organisationId, userId: actor.sub };
};

/**
 * Stripe's webhook. Mounted before the JSON parser and without sign-in: Stripe signs
 * the raw body instead, and the signature is checked before anything is read.
 */
export const stripeWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    await handleWebhook(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''));
    res.status(200).json({ received: true });
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : 500;
    if (status === 500) logger.error({ err: String(error) }, 'Stripe webhook failed');
    res.status(status).json({
      status: 'error',
      message: status === 500 ? 'The webhook could not be processed.' : (error as Error).message,
    });
  }
};

const billingRouter = Router();

billingRouter.use(authenticate);

billingRouter.get(
  '/',
  handle(async (req, res) => {
    res.status(200).json({ status: 'success', data: await billingService.overview(actorOf(req)) });
  }),
);

billingRouter.get(
  '/invoices/:id/pdf',
  handle(async (req, res) => {
    const invoice = await billingService.invoiceFor(actorOf(req), String(req.params['id']));
    const pdf = await invoicePdf(invoice);
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
    res.type('application/pdf').send(pdf);
  }),
);

billingRouter.get(
  '/organisations',
  requirePlatformAdmin,
  handle(async (_req, res) => {
    res.status(200).json({ status: 'success', data: await billingService.organisations() });
  }),
);

billingRouter.post(
  '/organisations/:id/credits',
  requirePlatformAdmin,
  handle(async (req, res) => {
    const actor = actorOf(req);
    const organisationId = String(req.params['id']);
    const dto = creditSchema.parse(req.body);
    const entry = await billingService.credit(actor.sub, organisationId, dto);
    await auditService.record({
      action: 'billing.credit.added',
      actorId: actor.sub,
      organisationId,
      targetType: 'organisation',
      targetId: organisationId,
      details: { amountCents: dto.amountCents, description: dto.description },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(201).json({ status: 'success', data: entry });
  }),
);

billingRouter.put(
  '/details',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const data = await billingService.saveDetails(actor, detailsSchema.parse(req.body));
    await auditService.record({
      action: 'billing.details.updated',
      actorId: actor.sub,
      organisationId: actor.organisationId,
      targetType: 'organisation',
      targetId: actor.organisationId ?? '',
      details: { country: data.country, currency: data.currency, vatCheck: data.vatCheck },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(200).json({ status: 'success', data });
  }),
);

billingRouter.post(
  '/checkout',
  handle(async (req, res) => {
    const { organisationId, userId } = ownerOf(req);
    const { amountCents } = checkoutSchema.parse(req.body);
    res
      .status(201)
      .json({ status: 'success', data: await createCheckout(organisationId, userId, amountCents) });
  }),
);

billingRouter.post(
  '/checkout/:id/confirm',
  handle(async (req, res) => {
    const { organisationId } = ownerOf(req);
    const data = await confirmCheckout(organisationId, String(req.params['id']));
    res.status(200).json({ status: 'success', data });
  }),
);

billingRouter.patch(
  '/organisations/:id',
  requirePlatformAdmin,
  handle(async (req, res) => {
    const actor = actorOf(req);
    const organisationId = String(req.params['id']);
    const { plan } = planSchema.parse(req.body);
    await billingService.setPlan(organisationId, plan);
    await auditService.record({
      action: 'billing.plan.changed',
      actorId: actor.sub,
      organisationId,
      targetType: 'organisation',
      targetId: organisationId,
      details: { plan },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(200).json({ status: 'success', data: { plan } });
  }),
);

billingRouter.get(
  '/revenue',
  requirePlatformAdmin,
  handle(async (req, res) => {
    const range = dateRangeSchema.parse(req.query);
    res.status(200).json({ status: 'success', data: await billingService.revenue(range) });
  }),
);

export { billingRouter };
