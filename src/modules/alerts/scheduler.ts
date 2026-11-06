/**
 * src/modules/alerts/scheduler.ts
 *
 * Sends due reports every minute, checks campaigns for alerts every few minutes,
 * invoices finished campaigns every five, and fetches exchange rates every six hours. Every API process can run it: reports
 * are claimed before sending, open alerts are unique, and a campaign is billed once.
 */
import { env } from '@/config/env';
import { billingService } from '@/modules/billing/billing.service';
import { refreshRates } from '@/modules/billing/currency';
import { runDueReports } from '@/modules/reports/report-delivery';
import { alertsService } from './alerts.service';
import { logger } from '@/lib/logger';
import { schedulerFailures, schedulerLastSuccess } from '@/lib/metrics';

const REPORT_CHECK_MS = 60_000;
const BILLING_CHECK_MS = 5 * 60_000;
// The ECB publishes once a working day, around 16:00 Frankfurt time.
const RATES_CHECK_MS = 6 * 60 * 60_000;
// The first check runs soon after startup rather than a full interval later.
const FIRST_CHECK_MS = 15_000;

/** Runs a task soon after startup and then on a timer, skipping a tick while one is running. */
const every = (task: () => Promise<unknown>, name: string, ms: number): (() => void) => {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    task()
      .then(() => schedulerLastSuccess.setToCurrentTime({ task: name }))
      .catch((error: unknown) => {
        schedulerFailures.inc({ task: name });
        logger.error({ err: String(error), task: name }, `${name} failed`);
      })
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(run, Math.min(FIRST_CHECK_MS, ms));
  const timer = setInterval(run, ms);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
};

export const startScheduler = (): (() => void) => {
  const stopReports = every(() => runDueReports(), 'Scheduled reports', REPORT_CHECK_MS);
  const stopAlerts = every(() => alertsService.check(), 'Alert check', env.ALERT_CHECK_MS);
  const stopBilling = every(() => billingService.run(), 'Billing', BILLING_CHECK_MS);
  const stopRates = every(() => refreshRates(), 'Exchange rates', RATES_CHECK_MS);

  return () => {
    stopReports();
    stopAlerts();
    stopBilling();
    stopRates();
  };
};
