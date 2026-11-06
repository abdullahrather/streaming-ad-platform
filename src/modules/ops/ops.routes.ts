/**
 * src/modules/ops/ops.routes.ts
 *
 * Operations endpoints, for machines rather than people:
 *
 * - GET /metrics, for Prometheus. With METRICS_TOKEN set it needs that bearer token;
 *   without one it's only served outside production.
 * - POST /ops/alerts, for Alertmanager. With ALERT_WEBHOOK_TOKEN as a bearer token, it
 *   emails each firing or resolved alert to the platform admins.
 */
import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { env } from '@/config/env';
import { handle } from '@/lib/http';
import { logger } from '@/lib/logger';
import { deliverEmail } from '@/lib/mailer';
import { registry } from '@/lib/metrics';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

/** Compares in constant time, so a wrong token can't be guessed a character at a time. */
const hasToken = (req: Request, token: string): boolean => {
  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/** Alertmanager's webhook body, the parts that matter here. */
const alertmanagerSchema = z.object({
  status: z.string(),
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).default({}),
        startsAt: z.string(),
      }),
    )
    .max(100),
});

const opsRouter = Router();

opsRouter.get(
  '/metrics',
  handle(async (req, res) => {
    const allowed = env.METRICS_TOKEN
      ? hasToken(req, env.METRICS_TOKEN)
      : env.NODE_ENV !== 'production';
    if (!allowed) throw new AppError(401, 'A valid metrics token is required.');
    res.type(registry.contentType).send(await registry.metrics());
  }),
);

opsRouter.post(
  '/ops/alerts',
  handle(async (req, res) => {
    if (!env.ALERT_WEBHOOK_TOKEN || !hasToken(req, env.ALERT_WEBHOOK_TOKEN)) {
      throw new AppError(401, 'A valid alert webhook token is required.');
    }
    const { alerts } = alertmanagerSchema.parse(req.body);
    const admins = await prisma.user.findMany({
      where: { role: Role.ADMIN, suspendedAt: null },
      select: { email: true },
    });

    for (const alert of alerts) {
      const name = alert.labels['alertname'] ?? 'Alert';
      const summary = alert.annotations['summary'] ?? name;
      const firing = alert.status === 'firing';
      logger.warn(
        { alert: name, status: alert.status, severity: alert.labels['severity'] },
        summary,
      );
      for (const { email } of admins) {
        await deliverEmail({
          to: email,
          subject: `${firing ? 'Firing' : 'Resolved'}: ${summary}`,
          body: [
            firing ? `${summary}` : `Resolved: ${summary}`,
            alert.annotations['description'] ?? '',
            `Severity: ${alert.labels['severity'] ?? 'unknown'}. Since ${alert.startsAt}.`,
            'Grafana and Alertmanager show the details.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        });
      }
    }
    res
      .status(200)
      .json({ status: 'success', data: { alerts: alerts.length, sentTo: admins.length } });
  }),
);

export { opsRouter };
