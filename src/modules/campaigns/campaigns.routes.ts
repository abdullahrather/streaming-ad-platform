/**
 * src/modules/campaigns/campaigns.routes.ts
 *
 * All campaign routes are protected by the JWT authenticate middleware.
 *
 * IMPORTANT: /campaigns/analytics and /campaigns/compare MUST be registered BEFORE /campaigns/:id
 * so Express doesn't interpret "analytics" as an ID parameter.
 */
import { Router } from 'express';
import { authenticate, requireWriteAccess } from '@/middleware/authenticate';
import { campaignsController } from './campaigns.controller';

const campaignsRouter = Router();

// Apply JWT guard to all routes in this router
campaignsRouter.use(authenticate);

campaignsRouter.get('/analytics', (req, res, next) => {
  void campaignsController.analytics(req, res, next);
});

campaignsRouter.get('/analytics/timeseries', (req, res, next) => {
  void campaignsController.timeseries(req, res, next);
});

campaignsRouter.get('/analytics/summary', (req, res, next) => {
  void campaignsController.summary(req, res, next);
});

campaignsRouter.get('/compare', (req, res, next) => {
  void campaignsController.compare(req, res, next);
});

campaignsRouter.post('/forecast', (req, res, next) => {
  void campaignsController.forecast(req, res, next);
});

campaignsRouter.get('/', (req, res, next) => {
  void campaignsController.list(req, res, next);
});

campaignsRouter.post('/', requireWriteAccess, (req, res, next) => {
  void campaignsController.create(req, res, next);
});

campaignsRouter.get('/:id/diagnosis', (req, res, next) => {
  void campaignsController.diagnosis(req, res, next);
});

campaignsRouter.get('/:id/analytics', (req, res, next) => {
  void campaignsController.campaignAnalytics(req, res, next);
});

campaignsRouter.get('/:id', (req, res, next) => {
  void campaignsController.get(req, res, next);
});

campaignsRouter.patch('/:id', requireWriteAccess, (req, res, next) => {
  void campaignsController.update(req, res, next);
});

campaignsRouter.delete('/:id', requireWriteAccess, (req, res, next) => {
  void campaignsController.remove(req, res, next);
});

export { campaignsRouter };
