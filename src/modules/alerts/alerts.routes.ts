/**
 * src/modules/alerts/alerts.routes.ts
 *
 * Campaign alerts for the organisations a person can see. Alerts open and
 * resolve on their own, so this is read-only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { actorOf, handle } from '@/lib/http';
import { authenticate } from '@/middleware/authenticate';
import { alertsService } from './alerts.service';

export const listAlertsQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('all'),
  campaignId: z.string().max(64).optional(),
});

const alertsRouter = Router();

alertsRouter.use(authenticate);

alertsRouter.get(
  '/',
  handle(async (req, res) => {
    const { status, campaignId } = listAlertsQuerySchema.parse(req.query);
    const data = await alertsService.list(actorOf(req), {
      open: status === 'open',
      ...(campaignId ? { campaignId } : {}),
    });
    res.status(200).json({ status: 'success', data });
  }),
);

export { alertsRouter };
