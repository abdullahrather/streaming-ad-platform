/**
 * src/modules/delivery/delivery.routes.ts
 *
 * Machine-to-machine endpoints for the ad server or player, guarded by an API
 * key rather than a user login.
 *
 * GET  /ad-decision  Which ad should play in this ad break?
 * POST /events       Record impressions, clicks and completions in a batch.
 */
import { Router } from 'express';
import { requireIngestKey } from '@/middleware/ingestKey';
import { adContextSchema, adDecisionQuerySchema, eventBatchSchema } from './delivery.schema';
import { deliveryService } from './delivery.service';
import { enqueueEvents } from './event-queue';

const deliveryRouter = Router();

deliveryRouter.get('/ad-decision', requireIngestKey, (req, res, next) => {
  void (async (): Promise<void> => {
    try {
      const query = adDecisionQuerySchema.parse(req.query);
      const { viewerId, breakId, consent } = adContextSchema.parse(req.query);
      const data = await deliveryService.decide(query, { viewerId, breakId, consent });

      res.status(200).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  })();
});

deliveryRouter.post('/events', requireIngestKey, (req, res, next) => {
  void (async (): Promise<void> => {
    try {
      const { events } = eventBatchSchema.parse(req.body);
      const data = await enqueueEvents(events);

      res.status(202).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  })();
});

export { deliveryRouter };
