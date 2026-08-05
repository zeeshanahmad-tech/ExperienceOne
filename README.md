# Experience One — AHI Hackathon, August 2026

The onboarding agent: "email us, you're in." An SME owner emails (or is forwarded an email to) a
dedicated address, gets a domain-researched company/interest profile drafted back, confirms or
refines it over email, and the confirmed profile hands off to Experience 2 (the report agent,
built by the other squad in a separate repo).

Full context, architecture, data model, and the day-by-day build plan: see
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Layout

```
apps/
  agent-service/   # Cloudflare Worker (Node/TS, Hono) — Gemini calls, Firestore, Resend, MCP
  email-worker/    # Cloudflare Worker — inbound email parsing, forwards to agent-service
  web/             # Static marketing page (Cloudflare Pages) — one form, one front door
```

Everything runs on Cloudflare + Firestore (Firebase's free Spark plan) — no GCP billing account
or credit card needed anywhere. See `IMPLEMENTATION_PLAN.md` §2 for why.

## Setup

```
npm install
```

`agent-service` and `email-worker` each have a `.dev.vars.example` — copy to `.dev.vars` for local
`wrangler dev` and fill in secrets (Gemini API key, Resend API key, the shared bearer token between
the two Workers, the Firestore service-account JSON). For deployed secrets use
`wrangler secret put <NAME>`. Never commit `.dev.vars` or paste keys into chat/PRs.
