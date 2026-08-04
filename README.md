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
  agent-service/   # Cloud Run service (Node/TS, Fastify) — Gemini calls, Firestore, Resend, MCP
  email-worker/    # Cloudflare Worker — inbound email parsing, forwards to agent-service
  web/             # Static marketing page (Cloudflare Pages) — one form, one front door
```

## Setup

```
npm install
```

Each app has its own `.env.example` — copy to `.env` and fill in per-app secrets (Gemini API key,
Resend API key, Firestore project, the shared bearer token between the Worker and the agent
service). Never commit `.env` files or paste keys into chat/PRs.
