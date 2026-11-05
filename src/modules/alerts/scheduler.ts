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
// The first check runs soon after startup rather than a full interval later.
const FIRST_CHECK_MS = 15_000;

/** Runs a task soon after startup and then on a timer, skipping a tick while one is running. */
const every = (task: () => Promise<unknown>, name: string, ms: number): (() => void) => {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    task()
      .catch((error: unknown) => console.error(`${name} failed:`, String(error)))
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

  return () => {
    stopReports();
    stopAlerts();
  };
};
