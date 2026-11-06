# Changelog

The main changes in each version. Every release's full notes are on the [Releases page](https://github.com/abdullahrather/streaming-ad-platform/releases).

## Unreleased

### Added

- Structured JSON logs with a request ID on every line, linked to traces, and sent to Loki when `LOKI_URL` is set
- Prometheus metrics at `/metrics`: request times by route, ad decisions, events and the queue, Postgres and Redis health, invoices, scheduled task failures, and backups
- OpenTelemetry traces for HTTP, Express and Redis, sent to Tempo when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Alert rules for outages, errors, slow requests, ad breaks without ads, the event worker and backups, emailed to platform admins through `/ops/alerts`
- `npm run db:backup`, `db:restore` and `db:restore-drill`; the drill restores into a scratch database and checks every table's row count, and runs in CI
- `npm run stack`: the platform with Grafana, Prometheus, Alertmanager, Loki, Tempo and daily backups in Docker
- `LOG_LEVEL`, `LOKI_URL`, `METRICS_TOKEN`, `ALERT_WEBHOOK_TOKEN` and `BACKUP_DIR` settings

### Fixed

- The Docker stack's seed failed while making demo videos, because it tried to remove the mounted media folder, so the stack had no ads

## 1.10.0

### Added

- Billing details for organisations, which decide the VAT: 19% for German customers, the reverse charge for EU businesses with a VAT ID confirmed by the EU's VIES service, and none outside the EU
- Invoices in the organisation's own currency at the European Central Bank's daily rate, showing the rate, the euro amounts and the VAT in euros
- Optional card payments through Stripe Checkout, credited once by webhook or when the payer comes back
- Starter, Growth and Enterprise plans that limit running campaigns, team members and scheduled reports, set by platform admins
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SELLER_NAME`, `SELLER_ADDRESS`, `SELLER_VAT_ID`, `ECB_RATES_URL` and `VIES_URL` settings

### Changed

- Running campaigns hold their unspent budget plus VAT, since the balance pays the invoice total
- Publisher revenue counts invoices as net amounts in euros
- Organisations from before plans are on Growth

## 1.9.0

### Added

- Prepaid balances: a ledger of credits and charges for each organisation, shown on a new Billing page for owners and managers
- Running campaigns hold their unspent budget; starting, resuming or raising a budget needs that much available, and is refused with 402 otherwise
- One invoice per campaign once its delivery is final, numbered with no gaps, paid from the balance, emailed to owners and downloadable as a PDF
- Publisher revenue for platform admins, by show, advertiser and ad slot, and adding credit to any organisation

### Changed

- Deleting a campaign invoices what it spent first
- Pausing, resuming or deleting a campaign now shows the reason when it is refused
- The AI section of the API docs says it can be turned on from the dashboard

## 1.8.0

### Added

- AI settings on the Assistant page for platform admins: choose a provider, paste a key (stored encrypted, never shown again), test the connection, and turn the assistant on or off with no restart
- For local models, the page finds Ollama, lists its models, and downloads new ones with a progress bar
- Settings changes in the activity log

### Changed

- `AI_PROVIDER` in `.env` still works and now locks the dashboard settings when set

## 1.7.0

### Added

- A delivery check on every campaign page: whether it will reach its goal, and the main reason if not, worked out with no AI
- An optional AI assistant, off by default, using Claude, any OpenAI-compatible API, or a free local model through Ollama
- Questions about campaigns in plain language, answered with read-only tools scoped to the person asking
- Suggested setting changes that apply only when an owner or manager approves them
- Campaign drafts from a written brief
- AI explanations on new alerts, a "what changed and why" paragraph in scheduled reports, and a first look at new ads for reviewers
- `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `AI_TIMEOUT_MS` and `AI_RATE_LIMIT` settings

## 1.6.0

### Added

- Reach and average frequency for any period, from daily HyperLogLog sketches
- The change against the previous period on every headline number
- A page that compares two to four campaigns side by side
- Drop-off by ad slot, device and show
- A report builder with CSV and PDF downloads, and saved reports
- Saved reports emailed every day or week, with a summary, open alerts and both files attached
- Alerts for delivery falling behind, budget running out early and sudden drops, emailed once when they open
- An Account setting to turn alert emails off, and attachments in the local mailbox
- `RUN_SCHEDULER` and `ALERT_CHECK_MS` settings

### Changed

- The forecast comparison uses lifetime reach, and the campaign page shows reach for the chosen period
- The breakdowns show each slot, device and show's completion rate

### Fixed

- A campaign no longer plays twice in the same ad break
- The forecast warns about an auction bid under the floor even when there's no traffic history

## 1.5.0

### Added

- Frequency caps, schedules, daily budgets and even, ASAP or custom pacing
- Consent-based audiences built from viewing interests, which viewers can delete
- Competitive separation within ad breaks, and multi-ad breaks on the demo site
- Second-price auctions, with the real cost of each impression recorded
- Per-ad results and A/B tests with a significance check
- Delivery and reach forecasts, with a backtest
- Ad request and audience recording

### Changed

- Spend now comes from recorded costs instead of impressions × CPM
- Player tokens carry the viewer's consent

## 1.4.0

### Added

- An event queue on Redis, with each event counted exactly once through retries and crashes
- Hard delivery limits that hold under concurrent traffic
- Short-lived player tokens
- Invalid traffic filtering, reported on each campaign
- A k6 load test that checks the database against accepted events

### Changed

- Redis is now required, and `npm run dev` starts it through Docker
- Ad decisions no longer query the database
- `POST /events` now needs an `eventId` and `occurredAt` on each event, within the last hour
- `/vast` now needs a player token

## 1.3.0

### Added

- Video ad upload with format checks, and conversion with FFmpeg
- An admin review queue, so ads can't run until they're approved
- VAST 4.2 ad serving with signed tracking links
- A player SDK that reports impressions, quartiles, completions and clicks
- A demo streaming site with pre-, mid- and post-roll ad breaks
- A chart of how far viewers watch each campaign's ads
- Fictional demo videos, generated when seeding

## 1.2.0

### Added

- Sign-up, email confirmation and password reset
- Organisations with invitations and owner, manager and analyst roles
- Rotating sessions, a device list and sign-out from all devices
- Two-factor login with an authenticator app and recovery codes
- An activity log, an admin console and a local mailbox for email

### Changed

- Campaigns belong to organisations instead of individual users
- Access tokens last 15 minutes, and refresh tokens use an httpOnly cookie

## 1.1.0

### Added

- Interactive API docs at `/docs`, generated from the validation schemas
- Read-only guest login and a public demo mode
- Demo traffic that runs inside the app, and only while someone is viewing it in demo mode
- Automatic version tags and GitHub Releases
- MIT license, contribution guide and this changelog
- Screenshots and a demo GIF in the README

### Changed

- The dashboard is now served with the same security headers as the API
- `npm run simulate` is replaced by the built-in demo traffic

## 1.0.0

### Added

- Campaigns with budgets, CPM, dates, goals and targeting
- Ad decisions and batched event tracking with hourly rollups
- Campaign management, analytics, pacing and breakdowns
- Live React dashboard with light and dark themes
- One-command local setup with PostgreSQL included
- Integration tests and CI for the API, dashboard and Docker
