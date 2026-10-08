# Nextera Wind Fleet

A wind-farm monitoring app. Turbines report power, wind speed, rotor speed, blade pitch and gearbox temperature every 5 minutes; operators watch the fleet live, drill into a turbine's history, get alerted on bad readings, and export reports.

```
turbines → Pub/Sub → Ingestion worker → Postgres + Redis → API & SSE → Angular app
                     (validate, store,                     (REST +
                      evaluate alert rules)                 live stream)
```

| Part | Stack | Local URL |
|---|---|---|
| Web app | Angular 22, Material, ECharts, Leaflet (nginx) | http://localhost:8082 |
| API & live events | NestJS, Prisma, Server-Sent Events | http://localhost:8080/api |
| Ingestion worker | NestJS (Pub/Sub push + CSV upload) | http://localhost:8081 |
| Data | PostgreSQL 18, Redis 8, Pub/Sub emulator | Docker Compose |

In production each part runs on Google Cloud Run, defined in `infra/terraform`.

## How it's used

1. **Farms**: a map and table of every farm → a farm's turbines → one turbine's charts (one per metric, zoomable) and readings.
2. **Turbines**: the whole fleet in one table, with status pills when a turbine stops reporting (no data in 15/30/60 min).
3. **Alerting**: define threshold rules (e.g. gearbox above 100 °C = error); every incoming reading is checked against them, and History shows what fired.
4. **Reporting**: pick a farm or turbine and a date range, see charts and a table, download a CSV.

New readings appear live, with no page reload. Users sign in with one of three roles: **viewer** (read-only), **owner** (also edits rules, runs reports) and **admin**.

## Run it locally

You need Docker and Node 24 (`.nvmrc`).

```bash
cp .env.example .env
# In .env, set:
#   JWT_SECRET=          output of: openssl rand -base64 48
#   SEED_USER_PASSWORD=  any password (12+ characters) for the demo users
# (If you change POSTGRES_PASSWORD, change it in DATABASE_URL too.)

npm install                           # backend packages and the shared Prisma client
docker compose up -d --wait --build   # database, Pub/Sub, migrations, API, ingestion, web
npm run db:seed:demo                  # demo users, 10 farms, 25 turbines, the last 72 h of data
```

Open http://localhost:8082 and sign in as `admin@nextera.local`, `owner@nextera.local` or `viewer@nextera.local` with your `SEED_USER_PASSWORD`.

**Live data (optional).** Set `DEMO_FEED_ENABLED=true` in `.env`, then run `docker compose up -d demo-feed`: every turbine reports a new reading every 5 minutes and the app updates live. Set it back to `false` and run the same command to stop it. Run `db:seed:demo` before you turn it on.

**Stop:** `docker compose down`. Add `-v` to also delete the database.

## Develop

```bash
docker compose up -d --wait postgres redis pubsub pubsub-init   # dependencies only
npm run db:deploy && npm run db:seed:demo                         # migrate + seed
npm run dev:api          # API on :3000, reloads on change
npm run dev:ingestion    # ingestion on :3001
cd apps/web && npm install && npm start   # web app on http://localhost:4200
```

Tests: `npm run lint && npm run typecheck && npm test && npm run test:e2e` at the repo root (e2e needs Docker), and `npm test` in `apps/web`.

## Ask the fleet from Claude

`apps/mcp` is a local, read-only [MCP](https://modelcontextprotocol.io) server: Claude can answer "which turbines stopped reporting?", "which turbines alerted in the last 24 h?" or "what's TURB002's gearbox doing?" straight from Postgres. Its tools are `list_farms`, `get_turbine`, `get_telemetry`, `get_telemetry_stats`, `list_alerts`, `list_alert_rules` and `get_report_summary`. Every database session is read-only, so it can't change any data.

```bash
docker compose up -d --wait postgres && npm run db:deploy && npm run db:seed:demo   # data to ask about
npm run build -w @nextera/mcp
```

- **Claude Code:** the repo's `.mcp.json` already registers it as `nextera` (it reads `DATABASE_URL` from the root `.env`). Restart Claude Code in the repo, approve the server (`/mcp` shows it), and ask.
- **Claude Desktop:** add it to `claude_desktop_config.json` (Settings → Developer → Edit Config) with an absolute path, then restart Claude Desktop. It reads the repo-root `.env` next to the script; `env` overrides it:

  ```json
  {
    "mcpServers": {
      "nextera": {
        "command": "node",
        "args": ["/absolute/path/to/nextera-code-assessment/apps/mcp/dist/main.js"],
        "env": { "DATABASE_URL": "postgresql://nextera:change-me@localhost:5433/nextera" }
      }
    }
  }
  ```

Use `MCP_DATABASE_URL` to point it at another database (in GCP: a role with only `SELECT`). Try the tools by hand with `npx @modelcontextprotocol/inspector node apps/mcp/dist/main.js`.

`CLAUDE.md` has the full reference: architecture, data model, auth, conventions and deployment.
