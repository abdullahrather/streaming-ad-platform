# Changelog

The main changes in each version. Every release's full notes are on the [Releases page](https://github.com/abdullahrather/streaming-ad-platform/releases).

## Unreleased

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
