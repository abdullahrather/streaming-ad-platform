/**
 * src/modules/alerts/scheduler.ts
 *
 * Sends due reports every minute and checks campaigns for alerts every few
 * minutes. Every API process can run it: reports are claimed before sending and
 * open alerts are unique, so nothing goes out twice.
 */
import { env } from '@/config/env';
import { runDueReports } from '@/modules/reports/report-delivery';
import { alertsService } from './alerts.service';

const REPORT_CHECK_MS = 60_000;

/** Runs a task on a timer, skipping a tick while the previous run is still going. */
const every = (task: () => Promise<unknown>, name: string, ms: number): NodeJS.Timeout => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((error: unknown) => console.error(`${name} failed:`, String(error)))
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  return timer;
};

export const startScheduler = (): (() => void) => {
  const reports = every(() => runDueReports(), 'Scheduled reports', REPORT_CHECK_MS);
  const alerts = every(() => alertsService.check(), 'Alert check', env.ALERT_CHECK_MS);

  return () => {
    clearInterval(reports);
    clearInterval(alerts);
  };
};
