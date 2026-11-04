/**
 * src/modules/reports/reports.routes.ts
 *
 * Anyone signed in can run and download reports over the campaigns they can
 * see. Owners and managers save them, schedule them and send them now.
 */
import { Router, type Response } from 'express';
import type { Report } from '@prisma/client';
import { seesAllOrganisations, type Actor } from '@/lib/actor';
import { actorOf, contextOf, handle } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { authenticate, requireWriteAccess } from '@/middleware/authenticate';
import { auditService } from '@/modules/audit/audit.service';
import { sendReport } from './report-delivery';
import { toCsv, toPdf } from './reports.export';
import {
  exportFormatSchema,
  reportDefinitionSchema,
  saveReportSchema,
  type ReportColumn,
  type ReportDefinition,
} from './reports.schema';
import { reportsService, type ReportResult } from './reports.service';

const reportsRouter = Router();

reportsRouter.use(authenticate);

const idOf = (id: unknown): string => String(id);

const definitionOf = (report: Report): ReportDefinition => ({
  campaignIds: report.campaignIds,
  groupBy: report.groupBy,
  columns: report.columns as ReportColumn[],
  rangeDays: report.rangeDays,
});

const organisationName = async (actor: Actor): Promise<string> => {
  if (seesAllOrganisations(actor)) return 'All organisations';
  const organisation = await prisma.organisation.findUnique({
    where: { id: actor.organisationId ?? '' },
  });
  return organisation?.name ?? '';
};

const sendFile = async (
  res: Response,
  actor: Actor,
  result: ReportResult,
  title: string,
  format: 'csv' | 'pdf',
): Promise<void> => {
  const stem = `${
    title
      .replace(/[^\w-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'report'
  }-${result.to.toISOString().slice(0, 10)}`;
  res.setHeader('Content-Disposition', `attachment; filename="${stem}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');

  if (format === 'csv') {
    // The byte order mark makes Excel read the file as UTF-8, so € shows correctly.
    res.type('text/csv; charset=utf-8').send(`\uFEFF${toCsv(result)}`);
    return;
  }
  const pdf = await toPdf(result, {
    title,
    organisation: await organisationName(actor),
    generatedAt: new Date(),
  });
  res.type('application/pdf').send(pdf);
};

/** Runs a report without saving it, for the builder's preview. */
reportsRouter.post(
  '/run',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const data = await reportsService.run(
      reportsService.scopeOf(actor),
      reportDefinitionSchema.parse(req.body),
    );
    res.status(200).json({ status: 'success', data });
  }),
);

/** Downloads an unsaved report as CSV or PDF. */
reportsRouter.post(
  '/export',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const { format } = exportFormatSchema.parse(req.query);
    const result = await reportsService.run(
      reportsService.scopeOf(actor),
      reportDefinitionSchema.parse(req.body),
    );
    await sendFile(res, actor, result, 'Campaign report', format);
  }),
);

reportsRouter.get(
  '/',
  handle(async (req, res) => {
    res.status(200).json({ status: 'success', data: await reportsService.list(actorOf(req)) });
  }),
);

reportsRouter.post(
  '/',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    reportsService.assertCanManage(actor);
    const report = await reportsService.create(actor, saveReportSchema.parse(req.body));
    await auditService.record({
      action: 'report.created',
      actorId: actor.sub,
      organisationId: report.organisationId,
      targetType: 'report',
      targetId: report.id,
      details: { name: report.name, schedule: report.schedule },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(201).json({ status: 'success', data: report });
  }),
);

reportsRouter.get(
  '/:id',
  handle(async (req, res) => {
    const report = await reportsService.findOneOrFail(idOf(req.params['id']), actorOf(req));
    res.status(200).json({ status: 'success', data: report });
  }),
);

reportsRouter.put(
  '/:id',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    reportsService.assertCanManage(actor);
    const report = await reportsService.update(
      idOf(req.params['id']),
      actor,
      saveReportSchema.parse(req.body),
    );
    await auditService.record({
      action: 'report.updated',
      actorId: actor.sub,
      organisationId: report.organisationId,
      targetType: 'report',
      targetId: report.id,
      details: { name: report.name, schedule: report.schedule },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(200).json({ status: 'success', data: report });
  }),
);

reportsRouter.delete(
  '/:id',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    reportsService.assertCanManage(actor);
    const report = await reportsService.remove(idOf(req.params['id']), actor);
    await auditService.record({
      action: 'report.deleted',
      actorId: actor.sub,
      organisationId: report.organisationId,
      targetType: 'report',
      targetId: report.id,
      details: { name: report.name },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

/** Runs a saved report and downloads it. */
reportsRouter.get(
  '/:id/export',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const { format } = exportFormatSchema.parse(req.query);
    const report = await reportsService.findOneOrFail(idOf(req.params['id']), actor);
    const result = await reportsService.run(
      { organisationId: report.organisationId },
      definitionOf(report),
    );
    await sendFile(res, actor, result, report.name, format);
  }),
);

/** Emails a saved report to its recipients now, outside its schedule. */
reportsRouter.post(
  '/:id/send',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    reportsService.assertCanManage(actor);
    const report = await reportsService.findOneOrFail(idOf(req.params['id']), actor);
    const sentTo = await sendReport(report);
    await auditService.record({
      action: 'report.sent',
      actorId: actor.sub,
      organisationId: report.organisationId,
      targetType: 'report',
      targetId: report.id,
      details: { name: report.name, recipients: sentTo },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(200).json({ status: 'success', data: { sentTo } });
  }),
);

export { reportsRouter };
