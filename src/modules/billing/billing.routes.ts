/**
 * src/modules/billing/billing.routes.ts
 *
 * Prepaid balances and invoices. Owners and managers see their organisation's
 * billing; platform admins add credit and see every balance and the revenue.
 */
import { Router } from 'express';
import { actorOf, contextOf, handle } from '@/lib/http';
import { authenticate, requirePlatformAdmin } from '@/middleware/authenticate';
import { auditService } from '@/modules/audit/audit.service';
import { dateRangeSchema } from '@/modules/campaigns/campaigns.schema';
import { invoicePdf } from './billing.pdf';
import { billingService, creditSchema } from './billing.service';

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

billingRouter.get(
  '/revenue',
  requirePlatformAdmin,
  handle(async (req, res) => {
    const range = dateRangeSchema.parse(req.query);
    res.status(200).json({ status: 'success', data: await billingService.revenue(range) });
  }),
);

export { billingRouter };
