# iMessage Insights

Read-only analytics UI for your local Messages database. Query, visualise, and extend your iMessage history without exporting or mutating the source data.

## Highlights

- Full-text search powered by SQLite FTS with boolean and `NEAR` operators
- Conversation-level stats, hourly and weekday cadence charts, and top contacts
- API layer backed by typed query helpers (`src/lib/imessage`) so you can add new aggregations without touching the UI
- Smoke-test harness with a synthetic database (`scripts/mock-db.ts`) to develop without personal conversations

## Data Safety

- The data layer opens the Messages database in **read-only** mode (`query_only` + `fileMustExist`).
- `.env*` files are git-ignored; configure `IMESSAGE_DB_PATH` locally so actual transcripts never leave your machine.
- The repo only ships with synthetic sample chats (names like “Alex” and “Blake”) generated under `scripts/mock-db.ts`. No personal conversations are included.

> **Heads up:** macOS protects `~/Library/Messages/chat.db`. Make sure the terminal you use to run these commands has **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) or you will see an `authorization denied` error from SQLite.

## Project layout

- `src/lib/imessage` – shared query logic that opens the database in read-only mode
- `src/app/api` – API routes for search and stats
- `src/components/dashboard.tsx` – client dashboard UI
- `scripts/mock-db.ts` – temporary SQLite file with synthetic data for smoke tests
- `scripts/smoke.ts` – runs the query layer against the mock database

## Prerequisites

- macOS host with access to `~/Library/Messages/chat.db`
- Node.js 20.9+ (Next.js 16 requirement)
- SQLite read permissions (grant Full Disk Access to your shell)

Optional: customise the database location via `.env` (see below).

## Setup

Install dependencies (already handled by `create-next-app`, but repeat if needed):

```bash
npm install
```

Copy `.env.example` and adjust the `IMESSAGE_DB_PATH` if your chat database lives somewhere else:

```bash
cp .env.example .env.local
```

## Smoke tests

Run the bundled smoke script to sanity-check the query layer against the synthetic dataset:

```bash
npm run smoke
```

It prints search results for the word `dinner` and a stats summary using the mock data.

To target your real Messages database (still read-only), grant the terminal Full Disk Access and run:

```bash
npm run smoke -- --real
```

The script will respect `IMESSAGE_DB_PATH` (or fall back to `~/Library/Messages/chat.db`) and never issues write queries.

## Local development

Start the Next.js dev server:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) for the overview, with dedicated pages at:

- `/messages` – iMessage insights dashboard
- `/calls` – FaceTime + phone call insights
- `/people` – people and contact insights
- `/reports` – shareable conversation reports

The messages dashboard lets you:

- Run advanced full-text searches (supports boolean/NEAR syntax from SQLite FTS)
- Filter by chat ID, date range, and sender type
- Review top chats, top contacts, hourly and weekday activity
- See friendly messaging tips and instructions if permissions are missing

## Production build

```bash
npm run build
npm start
```

## Extending

- Add new aggregations inside `src/lib/imessage/queries.ts` and surface them via a new API route.
- Use the existing mock database helper to seed predictable data when writing tests.
- Keep the connection read-only; `getDatabase` enforces `query_only` and `fileMustExist`.

## Tech stack

- Next.js 16 App Router, React 19, and TypeScript
- Tailwind CSS for styling
- `better-sqlite3` for performant, synchronous access to the Messages store
- tRPC + TanStack Query for typed client/server data fetching
