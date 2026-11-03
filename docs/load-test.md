# Load test results

These results are from `npm run load:test`, which runs the production build under [k6](https://k6.io) and then checks the database against what the API accepted. One lost or repeated event fails the run.

## Setup

Everything ran on one laptop, including the load generator:

| | |
|---|---|
| **CPU** | Intel Core Ultra 9 275HX, 24 cores |
| **Memory** | 31 GB |
| **System** | Windows 11, with Docker Desktop for Redis and k6 |
| **API** | 4 Node.js processes |
| **Worker** | 1 process |
| **Database** | PostgreSQL 18, local |
| **Queue** | Redis 8, with append-only persistence |

Events were sent in batches of 100. About 2% of batches were sent twice on purpose, to prove a retry can't count twice.

## Sustained load

Five minutes at 10,000 events per second:

| Measure | Result |
|---|---|
| Events accepted | 3,000,100 |
| Events in the database | 3,000,100 |
| **Lost or double-counted** | **0** |
| Replayed events dropped | 60,100 |
| Event API response time | p95 3.6 ms, p99 4.8 ms |
| Failed requests | 0.000% |
| Queue backlog when traffic stopped | None |

## Worker crash

The worker was killed with no warning 15 seconds into a 45-second run at 10,000 events per second, and a new one started 5 seconds later.

| Measure | Result |
|---|---|
| Events accepted | 450,000 |
| Events in the database | 450,000 |
| **Lost or double-counted** | **0** |
| Failed requests | 0.000% |
| Queue emptied after traffic stopped | 6.1 s |

The API kept accepting events while no worker was running, because they wait safely in the queue.

## Hard delivery limit

50,000 requests raced for a campaign limited to 10,000 ads. Exactly **10,000** ads were served.

## Peak rate

Short runs of 20 to 30 seconds, to find the limit:

| Target | Sustained | Lost or double-counted | Event API p95 | Event API p99 |
|---|---|---|---|---|
| 25,000/s | 25,001/s | 0 | 3.2 ms | 4.2 ms |
| 50,000/s | 50,001/s | 0 | 3.2 ms | 6.6 ms |
| 100,000/s | 99,457/s | 0 | 54.8 ms | 455.3 ms |

Nothing was lost at any rate. Response times start to climb near 100,000 events per second, so that's close to the limit of this setup.

## Ad decisions

| Target | Served | p95 | Failed |
|---|---|---|---|
| 2,000/s | 2,000/s | 1.8 ms | 0.000% |
| 8,000/s | About 7,900/s | 4.6 to 6.5 ms | 0.000% to 0.011% |

The small failure rate at 8,000 per second comes from a burst of new connections as the phase starts. Lengthening the connection queue reduced it from 0.688%. Rates above 8,000 per second were not tested.

## After adding campaign rules

Campaign rules made every ad decision do more, so the test was repeated on that code: five minutes at 10,000 events per second, then one minute of decisions at 8,000 per second.

| Measure | Result |
|---|---|
| Events accepted | 3,000,100 |
| Events in the database | 3,000,100 |
| **Lost or double-counted** | **0** |
| Event API response time | p95 3.7 ms, p99 5.0 ms |
| Decisions | 7,968/s, p95 6.2 ms, 0.000% failed |
| Ads served against a limit of 10,000 | 10,000, from 50,000 racing requests |

Decisions in this test used no frequency cap or audience, so they don't measure the extra Redis reads those add.

## Limits of these results

- The load generator shared the laptop with the system under test, so a dedicated setup may behave differently.
- Traffic was synthetic and used one campaign, show and placement. More varied traffic means more rollup rows per write.
- Peak runs lasted 20 to 30 seconds. Only the 10,000 per second rate was sustained for five minutes.
- Duplicate checking uses about 105 bytes of Redis memory per event for one hour, so 10,000 events per second needs about 3.8 GB.

## Run it yourself

Docker Desktop must be running.

```bash
npm run load:test
```

| Setting | Default | Meaning |
|---|---|---|
| `RATE` | 10000 | Events per second |
| `DURATION` | 5m | How long to send events |
| `BATCH` | 100 | Events per request |
| `DECISION_RATE` | 2000 | Ad decisions per second |
| `API_PROCESSES` | 4 | API processes to run |
| `WORKERS` | 1 | Worker processes to run |
| `CRASH` | Off | Set to 1 to kill the worker partway through |
