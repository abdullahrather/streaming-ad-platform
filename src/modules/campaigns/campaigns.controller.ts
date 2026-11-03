/**
 * src/modules/campaigns/campaigns.controller.ts
 *
 * Thin HTTP layer — validates input, calls service, formats responses.
 * Controllers must not contain business logic.
 */
import { Request, Response, NextFunction } from 'express';
import { actorOf, contextOf } from '@/lib/http';
import { reachKey, redis } from '@/lib/redis';
import { auditService } from '@/modules/audit/audit.service';
import { creativesService } from '@/modules/creatives/creatives.service';
import {
  createCampaignSchema,
  dateRangeSchema,
  forecastSchema,
  listCampaignsQuerySchema,
  updateCampaignSchema,
} from './campaigns.schema';
import { campaignsService } from './campaigns.service';
import { forecastCampaign } from './forecast.service';

const idOf = (req: Request): string => req.params['id'] as string;

export class CampaignsController {
  /** GET /campaigns */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listCampaignsQuerySchema.parse(req.query);
      const result = await campaignsService.listCampaigns(actorOf(req), query);

      res.status(200).json({ status: 'success', ...result });
    } catch (error) {
      next(error);
    }
  }

  /** POST /campaigns */
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = createCampaignSchema.parse(req.body);
      const actor = actorOf(req);
      const campaign = await campaignsService.createCampaign(actor, dto);

      await auditService.record({
        action: 'campaign.created',
        actorId: actor.sub,
        organisationId: campaign.organisationId,
        targetType: 'campaign',
        targetId: campaign.id,
        details: { title: campaign.title },
        ipAddress: contextOf(req).ipAddress,
      });

      res.status(201).json({ status: 'success', data: campaign });
    } catch (error) {
      next(error);
    }
  }

  /** POST /campaigns/forecast */
  async forecast(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await forecastCampaign(forecastSchema.parse(req.body));

      res.status(200).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/:id */
  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaign = await campaignsService.findOneOrFail(idOf(req), actorOf(req));

      res.status(200).json({ status: 'success', data: campaign });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /campaigns/:id */
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = updateCampaignSchema.parse(req.body);
      const actor = actorOf(req);
      const campaign = await campaignsService.updateCampaign(idOf(req), actor, dto);

      await auditService.record({
        action: 'campaign.updated',
        actorId: actor.sub,
        organisationId: campaign.organisationId,
        targetType: 'campaign',
        targetId: campaign.id,
        details: { title: campaign.title, fields: Object.keys(dto) },
        ipAddress: contextOf(req).ipAddress,
      });

      res.status(200).json({ status: 'success', data: campaign });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /campaigns/:id */
  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      await campaignsService.findOneOrFail(idOf(req), actor);
      await creativesService.removeFilesForCampaign(idOf(req));
      const campaign = await campaignsService.deleteCampaign(idOf(req), actor);

      await auditService.record({
        action: 'campaign.deleted',
        actorId: actor.sub,
        organisationId: campaign.organisationId,
        targetType: 'campaign',
        targetId: campaign.id,
        details: { title: campaign.title },
        ipAddress: contextOf(req).ipAddress,
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/analytics */
  async analytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const range = dateRangeSchema.parse(req.query);
      const data = await campaignsService.getAnalytics(actorOf(req), range);

      res.status(200).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/analytics/timeseries */
  async timeseries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const range = dateRangeSchema.parse(req.query);
      const data = await campaignsService.getTimeseries(actorOf(req), range);

      res.status(200).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/:id/analytics */
  async campaignAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      const id = idOf(req);
      const range = dateRangeSchema.parse(req.query);

      const breakdown = await campaignsService.getBreakdown(id, actor, range);
      const filtered = await campaignsService.getFiltered(id, range);
      const reach = await redis.pfcount(reachKey(id));
      const [[campaign], timeseries] = await Promise.all([
        campaignsService.getAnalytics(actor, range, id),
        campaignsService.getTimeseries(actor, range, id),
      ]);

      res
        .status(200)
        .json({ status: 'success', data: { campaign, timeseries, breakdown, filtered, reach } });
    } catch (error) {
      next(error);
    }
  }
}

export const campaignsController = new CampaignsController();
