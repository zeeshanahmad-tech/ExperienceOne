# Deployment guide — Experience 1 (Onboarding Agent)

For architecture, data model, and the "why" behind decisions, see `IMPLEMENTATION_PLAN.md`. This file is
just the practical "how to deploy" reference — every command below has been run and verified working.

## Prerequisites (once per machine)

1. `npm install` at the repo root (installs all three `apps/*` workspaces).
2. `npx wrangler login` — authenticate with Cloudflare, if not already.
3. **Set the account explicitly.** This Cloudflare login has access to more than one account, and
   `wrangler` cannot auto-select one in non-interactive mode — every deploy/secret command below will
   fail with "More than one account available" unless this is set first:
   ```
   export CLOUDFLARE_ACCOUNT_ID=ad0e82073fe55145813d96a272b9631f   # "Jd@j24d.com's Account" — owns ahiapp.ai
   ```
   This is the account that owns the `ahiapp.ai` zone — Email Routing can only route to Workers that
   live in the same account as the zone, so this is not optional.

## Currently live

| Component | URL | Cloudflare resource name |
|---|---|---|
| Marketing page | `https://experience-one-web.pages.dev/` | Pages project `experience-one-web` |
| Agent brain | `https://experience-one-agent-service.jd-ad0.workers.dev` | Worker `experience-one-agent-service` |
| Email parser | `https://experience-one-email-worker.jd-ad0.workers.dev` | Worker `experience-one-email-worker` |

`labs@radar.ahiapp.ai` (Cloudflare Email Routing, zone `ahiapp.ai`) routes to `experience-one-email-worker`.

## Deploying `apps/web` (the marketing page)

Direct upload to Cloudflare Pages — **no Git integration is set up**, so pushing to GitHub does *not*
auto-deploy this. Every change needs a manual redeploy:

```
cd apps/web  # or run from repo root and point at apps/web, doesn't matter
npx wrangler pages deploy apps/web --project-name experience-one-web --branch main --commit-dirty=true
```

(`--commit-dirty=true` just silences a warning about uncommitted git changes — harmless, doesn't affect
what gets deployed, since this command uploads the literal files in `apps/web`, not a git ref.)

**Before deploying, always check** the `AGENT_SERVICE_URL` constant near the top of the `<script>` block
in `index.html` points at the real deployed Worker URL above, not `""` (DEMO mode) or a `localhost`
value left over from local testing. If it's wrong, the whole page silently falls back to simulating
responses instead of calling the real backend.

First-time-only step (already done, won't need repeating unless the project is deleted): a Pages
project has to exist before you can deploy to it —
`npx wrangler pages project create experience-one-web --production-branch main`.

## Deploying `apps/agent-service` (the agent brain — Cloudflare Worker)

```
cd apps/agent-service
npx wrangler deploy
```

Non-secret config lives in `wrangler.toml`'s `[vars]` block (`RESEND_SENDING_DOMAIN`, `REPLY_TO_ADDRESS`,
`AHI_MCP_URL`) and deploys automatically with the code — edit that file directly for those.

**Secrets** are separate from `wrangler.toml` and must be pushed explicitly (they don't come from a
`.dev.vars` file automatically — that file is for local `wrangler dev` only):
```
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put WORKER_SHARED_TOKEN
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```
Each prompts for the value — paste it and press enter (or pipe it non-interactively:
`echo "$VALUE" | npx wrangler secret put NAME`, useful for scripting, but never echo the value to a
terminal/log where it'd be visible). These only need re-running when a secret's *value* changes, not on
every code deploy. `WORKER_SHARED_TOKEN` must be the **same value** on both `agent-service` and
`email-worker` — it's how they authenticate to each other.

Verify after deploying: `curl https://experience-one-agent-service.jd-ad0.workers.dev/healthz` should
return `{"ok":true}`.

## Deploying `apps/email-worker` (inbound email parser — Cloudflare Worker)

```
cd apps/email-worker
npx wrangler deploy
```

`AGENT_SERVICE_URL` lives in this Worker's own `wrangler.toml` `[vars]` block — must match wherever
`agent-service` is actually deployed (see table above). `WORKER_SHARED_TOKEN` is a secret here too, set
the same way as above, and must match `agent-service`'s value exactly.

This Worker has no meaningful HTTP endpoint of its own (only an `email()` handler) — it's triggered by
Cloudflare Email Routing, not visited directly. A deployed URL exists but returns nothing useful.

**The Email Routing rule itself** (which address routes to this Worker) is configured in the Cloudflare
dashboard, not via `wrangler` — the account's API token here lacks the `email_routing:write` scope, so
this step can't be scripted. Dashboard → Email Routing → `ahiapp.ai` → Routing rules → the
`labs@radar.ahiapp.ai` rule → should point to **Send to a Worker → experience-one-email-worker**.
Only needs touching if the destination Worker's name ever changes.

## Local dev (before deploying)

Each Worker has a `.dev.vars.example` — copy to `.dev.vars` (gitignored, never commit) and fill in real
values for local testing:
```
cd apps/agent-service && npx wrangler dev --port 8787
cd apps/email-worker && npx wrangler dev
```
`.dev.vars` values are separate from the deployed secrets above — populating one doesn't populate the
other. Ask a teammate for the real values rather than generating new ones, except `WORKER_SHARED_TOKEN`,
which can be freshly generated (`openssl rand -hex 32`) as long as it's set identically on both Workers,
locally and deployed.
