/**
 * src/modules/campaigns/campaigns.controller.ts
 *
 * Thin HTTP layer — validates input, calls service, formats responses.
 * Controllers must not contain business logic.
 */
import { Request, Response, NextFunction } from 'express';
import { actorOf, contextOf } from '@/lib/http';
import { reachBetween, reachKey, redis } from '@/lib/redis';
import { auditService } from '@/modules/audit/audit.service';
import { creativesService } from '@/modules/creatives/creatives.service';
import {
  compareQuerySchema,
  createCampaignSchema,
  dateRangeSchema,
  forecastSchema,
  listCampaignsQuerySchema,
  previousRange,
  updateCampaignSchema,
} from './campaigns.schema';
import { campaignsService } from './campaigns.service';
import { diagnosisService } from './diagnosis.service';
import { forecastCampaign } from './forecast.service';

const idOf = (req: Request): string => req.params['id'] as string;

/** How many times the average viewer saw the ad. Reach is an estimate, so this is too. */
const averageFrequency = (impressions: number, reach: number): number =>
  reach > 0 ? Math.max(1, impressions / reach) : 0;

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

  /** GET /campaigns/analytics/summary */
  async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      const range = dateRangeSchema.parse(req.query);
      const [current, previous] = await Promise.all([
        campaignsService.getPeriodTotals(actor, range),
        campaignsService.getPeriodTotals(actor, previousRange(range)),
      ]);

      res.status(200).json({ status: 'success', data: { current, previous } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/:id/diagnosis */
  async diagnosis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await diagnosisService.diagnose(idOf(req), actorOf(req));
      res.status(200).json({ status: 'success', data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /campaigns/compare */
  async compare(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      const { ids, from, to } = compareQuerySchema.parse(req.query);
      const range = { from, to };

      const data = await Promise.all(
        ids.map(async (id) => {
          await campaignsService.findOneOrFail(id, actor);
          const [[campaign], timeseries, reach] = await Promise.all([
            campaignsService.getAnalytics(actor, range, id),
            campaignsService.getTimeseries(actor, range, id),
            reachBetween(id, from, to),
          ]);
          return {
            campaign,
            timeseries,
            reach,
            averageFrequency: averageFrequency(campaign?.impressions ?? 0, reach),
          };
        }),
      );

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
      const earlier = previousRange(range);
      const [[campaign], timeseries, filtered, previous, reach, previousReach, lifetimeReach] =
        await Promise.all([
          campaignsService.getAnalytics(actor, range, id),
          campaignsService.getTimeseries(actor, range, id),
          campaignsService.getFiltered(id, range),
          campaignsService.getPeriodTotals(actor, earlier, id),
          reachBetween(id, range.from, range.to),
          reachBetween(id, earlier.from, earlier.to),
          redis.pfcount(reachKey(id)),
        ]);

      res.status(200).json({
        status: 'success',
        data: {
          campaign,
          timeseries,
          breakdown,
          filtered,
          reach,
          averageFrequency: averageFrequency(campaign?.impressions ?? 0, reach),
          lifetimeReach,
          previous: {
            ...previous,
            reach: previousReach,
            averageFrequency: averageFrequency(previous.impressions, previousReach),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const campaignsController = new CampaignsController();
