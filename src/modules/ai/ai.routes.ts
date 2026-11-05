/**
 * src/modules/ai/ai.routes.ts
 *
 * The AI assistant. Every route that calls the model is rate-limited per person,
 * because each call can cost the platform's owner money with a paid provider.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '@/config/env';
import { actorOf, contextOf, handle } from '@/lib/http';
import { authenticate, requireWriteAccess } from '@/middleware/authenticate';
import { auditService } from '@/modules/audit/audit.service';
import { aiStatus } from './ai.config';
import { aiService, askSchema } from './ai.service';

export const draftSchema = z.object({
  brief: z.string({ error: 'Describe the campaign.' }).trim().min(10).max(4000),
});

const aiRouter = Router();

aiRouter.use(authenticate);

const aiLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.AI_RATE_LIMIT,
  keyGenerator: (req) => req.user?.sub ?? 'anonymous',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many AI requests. Try again in a few minutes.' },
});

aiRouter.get('/status', (_req, res) => {
  res.status(200).json({ status: 'success', data: aiStatus() });
});

aiRouter.post(
  '/ask',
  aiLimiter,
  handle(async (req, res) => {
    const data = await aiService.ask(actorOf(req), askSchema.parse(req.body));
    res.status(200).json({ status: 'success', data });
  }),
);

aiRouter.get(
  '/campaigns/:id/recommendations',
  handle(async (req, res) => {
    const data = await aiService.listRecommendations(actorOf(req), String(req.params['id']));
    res.status(200).json({ status: 'success', data });
  }),
);

aiRouter.post(
  '/campaigns/:id/recommendations',
  requireWriteAccess,
  aiLimiter,
  handle(async (req, res) => {
    const data = await aiService.recommend(actorOf(req), String(req.params['id']));
    res.status(201).json({ status: 'success', data });
  }),
);

for (const decision of ['approve', 'reject'] as const) {
  aiRouter.post(
    `/recommendations/:id/${decision}`,
    requireWriteAccess,
    handle(async (req, res) => {
      const actor = actorOf(req);
      const { recommendation } = await aiService.decide(actor, String(req.params['id']), decision);
      await auditService.record({
        action: decision === 'approve' ? 'ai.recommendation.applied' : 'ai.recommendation.rejected',
        actorId: actor.sub,
        organisationId: recommendation.organisationId,
        targetType: 'campaign',
        targetId: recommendation.campaignId,
        details: { title: recommendation.title, change: recommendation.change },
        ipAddress: contextOf(req).ipAddress,
      });
      res.status(200).json({ status: 'success', data: recommendation });
    }),
  );
}

aiRouter.post(
  '/draft-campaign',
  requireWriteAccess,
  aiLimiter,
  handle(async (req, res) => {
    const { brief } = draftSchema.parse(req.body);
    const data = await aiService.draftCampaign(actorOf(req), brief);
    res.status(200).json({ status: 'success', data });
  }),
);

export { aiRouter };
