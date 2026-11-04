# How reporting and alerts work

The dashboard answers business questions as well as showing totals: how many different people saw a campaign, how this week compares with last week, which of two campaigns did better, and whether anything needs attention. Reports go out by email on a schedule, and alerts arrive without anyone opening the dashboard.

## Reach and average frequency

**Reach** is how many different viewers saw a campaign. **Average frequency** is how many times the average viewer saw it: impressions divided by reach.

Counting different viewers exactly would mean storing every viewer ID per campaign. Instead, each impression adds its viewer to a [HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/) sketch in Redis. A sketch takes at most 12 KB however many viewers it holds. Its standard error is about 0.8%, so counts are usually within 1 to 2%.

Viewer IDs are hashed with SHA-1 before they go in. Without that, IDs that look alike, such as `viewer-1`, `viewer-2` and so on, came out about 3% low at a million viewers. Hashed, they're as accurate as random IDs.

There is one sketch per campaign per day, plus one for the campaign's lifetime. Reach for a period merges the daily sketches it covers, so a viewer who watched on three days still counts once. The daily sketches are kept for 400 days.

Reach can't be added up across rows, since a viewer seen in two countries is still one viewer. So reports only offer reach and average frequency when each row is a campaign, and the total merges the sketches rather than adding the rows.

## Comparing periods and campaigns

The overview and each campaign page show the change against the previous period of the same length. For "7 days", that's the 7 days before.

- **Counts** such as impressions, clicks and spend show a percentage change.
- **Rates** such as click-through and completion show the change in percentage points, so 2.0% to 2.4% reads as "+0.4 pts", not "+20%".
- **Spend and frequency** aren't coloured green or red, because more isn't better or worse in itself.

The Compare page puts two to four campaigns side by side: their trend on one chart, and a table of reach, frequency, click-through, completion, spend, cost per thousand and pacing. Each campaign keeps its colour while it stays selected.

## Where viewers stop watching

The campaign page shows how far viewers get through an ad, at 25%, 50%, 75% and the end. The breakdown can be split by ad slot, device or show. For example, pre-rolls usually lose more viewers than mid-rolls, because viewers are waiting for the show to start.

## Reports

The Reports page builds a table from four choices:

| Choice | Options |
|---|---|
| Rows | Day, campaign, ad slot, country, device or show |
| Columns | Impressions, clicks, CTR, how many reached 25%, 50% and 75%, completions, completion rate, spend, eCPM, reach and average frequency |
| Campaigns | Any of the organisation's campaigns, or all of them |
| Period | The last 1, 7, 14, 30 or 90 days, up to the current hour |

The preview updates as you change the options. Downloads come as CSV or PDF.

- **CSV:** opens cleanly in Excel. Cells starting with `=`, `+`, `-` or `@` get a leading `'`, so a campaign named like a formula can't run as one.
- **PDF:** an A4 table with a totals row, repeating its header on every page.
- **Days:** follow `PLATFORM_TIMEZONE`, so "Monday" means Monday where the business runs.

Everyone in an organisation can run and download reports. Owners and managers can also save them, and the read-only guest account can run them over the demo data.

## Scheduled reports

A saved report can be emailed every day or every week, at a chosen hour in the platform time zone. Each email contains:

- a short summary of impressions, clicks, CTR, completion rate and spend, with the change against the previous period
- any open alerts
- the full report attached as CSV and PDF

Recipients must be members of the organisation. Anyone who has left by the time it sends is skipped.

Every API process checks for due reports once a minute. Before sending, a process claims the report by moving its next send time forward, with a condition that the time is still the one it read. If two processes find the same due report, only one claim succeeds, so nobody gets it twice. The next send time is worked out hour by hour in the platform time zone, which keeps it at the right local hour when the clocks change.

Without `SMTP_URL`, emails and their attachments go to the local mailbox at `/#/mailbox`.

## Alerts

Running campaigns are checked every five minutes (`ALERT_CHECK_MS`), and once shortly after startup.

| Alert | Opens when | Resolves when |
|---|---|---|
| **Delivery behind schedule** | At least a day into the flight, delivery is under 80% of an even schedule | Delivery reaches 90% |
| **Budget running out early** | At the last 24 hours' spend rate, the budget runs out before the campaign ends and before it reaches its goal | That's no longer true |
| **Sudden drop in impressions** | The last two complete hours delivered under half the same two hours' average on the previous three days | It recovers to 75% |

Opening and resolving use different thresholds, so an alert doesn't flicker on and off around a single value.

A drop isn't judged where a quiet period is expected:

- **Outside the schedule:** hours the campaign's schedule leaves out.
- **Daily limit reached:** once the day's impression or budget limit is close to reached.
- **Too little traffic:** below 60 impressions per window.

An alert is emailed once, when it opens, to members who have alert emails on. That's the default, and each member can turn it off under Account. Paused, finished and deleted campaigns have their alerts resolved.

A partial unique index allows only one open alert per campaign and type. When several processes check at once, only the first insert succeeds, and only that process sends the email.

## Why PostgreSQL is enough, for now

The roadmap planned an analytics database such as ClickHouse "if PostgreSQL reaches its limits". It hasn't, for this workload, because the hourly rollups keep the table small. Rows grow with campaigns × hours × targeting mixes, not with raw events, so 10,000 events a second becomes a few thousand rows an hour.

These are the report queries on a generated table of **9.9 million rows (1.8 GB)**: 200 campaigns, 90 days of hourly data, and 23 show, slot, country and device mixes per hour. The median of three warm runs on a 24-thread laptop:

| Query | Median |
|---|---|
| One organisation, 90 days, by day | 524 ms |
| One organisation, 90 days, by campaign | 374 ms |
| One organisation, 7 days, by show | 49 ms |
| One organisation, 7-day summary | 48 ms |
| Every organisation (platform admin), 90 days, by day | 2.1 s |
| Alert check across all 200 running campaigns | 2.3 s, in the background |

Reports an advertiser waits for stay under a second, and the slower queries run rarely or in the background.

ClickHouse becomes worth its extra moving part when the rollups reach hundreds of millions of rows: thousands of campaigns with long histories, or many more targeting dimensions. At that point, roughly in order:

1. Pre-aggregate daily rollups for long ranges.
2. Partition `metrics` by month.
3. Move reporting reads to ClickHouse, fed from the same event queue.

## Limits

- Reach is an estimate, usually within 1 to 2%. It also counts viewers per UTC day, so a period that starts mid-day includes that whole day's viewers.
- Reach only counts viewers the player identifies. Impressions without a viewer ID add to impressions but not to reach.
- Alert thresholds are fixed, not per campaign.
- A report email that fails to send isn't retried until its next scheduled time.
