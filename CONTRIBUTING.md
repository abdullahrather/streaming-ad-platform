# Contributing

Thanks for your interest. Bug reports, ideas and pull requests are all welcome.

## Getting started

You need Node.js 22 or newer and Docker Desktop, which runs Redis.

```bash
npm install
npm run dev
```

See the [README](./README.md) for the demo logins.

## Before you open a pull request

Run these checks, which CI also runs:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run typecheck --prefix web
npm run check:translations --prefix web
```

`npm test` runs against real PostgreSQL and Redis, which start automatically and stay separate from your development data.

The browser tests run against the app on port 3000. With `npm run dev` running and the dashboard built, run them in a second terminal:

```bash
npm run build --prefix web
npx playwright install chromium
npm run test:e2e
```

They sign in many times, so start the app with a higher sign-in limit, such as `LOGIN_RATE_LIMIT=1000 npm run dev`.

## Guidelines

- Keep each pull request to one change, and explain why it's needed.
- Add or update tests when behaviour changes.
- Pass dashboard text through `t()` and add the German to `web/src/locales/de.ts`. `npm run check:translations` finds anything missed.
- If you change the database, add a migration with `npx prisma migrate dev`.
- If you add or change a route, update `src/modules/docs/openapi.ts`. A test fails when a route is missing from the docs.
- Use only fictional brands and data in examples, seeds and tests.

## Releases

Merging a pull request creates a version automatically. It's a patch by default. Add the label `release:minor` for a new feature, `release:major` for a breaking change, or `skip-release` for no release.

## Reporting a security problem

Please don't open a public issue. Use GitHub's private vulnerability reporting on the repository's **Security** tab.
