# AGENTS.md — context for AI coding agents (Claude, Copilot, Codex, etc.)

This file exists so any AI agent picking up this repo — not just Claude Code — has working context
without re-deriving it from scratch. It captures **decisions and their reasons**, **current verified
state**, and **exactly where things were left off**. For full architecture/why, see
`IMPLEMENTATION_PLAN.md`. For deploy commands, see `CLAUDE.md`. This file is the fast-orientation
layer on top of both, plus the most recent in-flight design work that isn't written up anywhere else yet.

**Verified as of 2026-08-07**: current branch `main`, working tree clean, HEAD at commit `8a54948`
("agent: send the HTML profile email").

---

## 1. What this project is

"Experience 1" — one of several tracks in an internal AI hackathon (AHI Hackathon, Aug 2026). This repo
builds an **email-based onboarding agent**: a business emails (or forwards an email to) one address,
the agent researches their company using Gemini, emails back a draft profile, the human confirms or
edits it over a normal email reply thread, and once confirmed the profile hands off to "Experience 2"
(a separate team's weekly-report agent — out of scope here, only demonstrated via one light MCP query).

Hard requirement from the brief: the stack must use Gemini, and specifically **Gemini managed agents**
(the Interactions API) somewhere — not just plain `generateContent` calls. That requirement is the
reason for the in-flight work described in §5 below.

Explicitly out of scope: billing, login/accounts, WhatsApp/SMS, dashboards.

## 2. The three apps

- **`apps/web`** — static marketing page, deployed to Cloudflare Pages via **direct upload, no Git
  integration** — pushing to GitHub does NOT auto-deploy this; every change needs a manual
  `wrangler pages deploy`. Owned/edited by a teammate as well as this agent; check the
  `AGENT_SERVICE_URL` constant near the top of `index.html`'s `<script>` block before ever deploying —
  if it's empty or `localhost`, the page silently falls back to a fake-demo mode instead of calling the
  real backend.
- **`apps/email-worker`** — Cloudflare Worker, inbound MIME parser. Has no meaningful HTTP surface of
  its own; it's triggered by Cloudflare Email Routing's `email()` handler, not visited directly. Its
  only job: parse the raw email, forward the parsed fields to `agent-service`'s `POST /inbound-email`
  with a shared bearer token.
- **`apps/agent-service`** — the actual brain. Cloudflare Worker running Hono. Does the Gemini calls,
  Firestore reads/writes, outbound email sending, and the one demo MCP query. Everything interesting
  lives here.

## 3. Currently live (as of last deploy)

| Component | URL |
|---|---|
| Marketing page | `https://experience-one-web.pages.dev/` |
| Agent brain | `https://experience-one-agent-service.jd-ad0.workers.dev` |
| Email parser | `https://experience-one-email-worker.jd-ad0.workers.dev` |

`labs@onboard.ahiapp.ai` (Cloudflare Email Routing, zone `ahiapp.ai`) is the one address the whole flow
is keyed off — both receiving (routes to `experience-one-email-worker`) and sending (Cloudflare's native
Email Sending, not Resend — see §4).

**Never deploy, push, or commit without asking first** — see §7. This applies to every AI agent working
in this repo, not just Claude.

## 4. Key decisions already made, and why (don't re-litigate these without a reason)

- **No Cloud Run — Firestore (Firebase Spark/free plan) is the one GCP product used.** Originally
  planned around Cloud Run; abandoned because no one on the team has a card to attach to a GCP billing
  account, which Cloud Run requires even to stay in a free tier. Firestore's Spark plan needs no card at
  all and still satisfies the brief's "≥1 Google Cloud product" rule.
- **Firestore is accessed via a hand-rolled REST client (`src/firestore.ts`), not `firebase-admin`.**
  Cloudflare Workers has no Node runtime, so the usual SDK doesn't work. The client signs its own JWT
  with the service account's private key via Web Crypto, exchanges it for an OAuth token, then calls the
  Firestore REST API directly.
- **Outbound email uses Cloudflare's native `send_email` binding, not Resend.** Resend + a
  split-sending-domain + Reply-To trick worked, but meant two vendors coordinating DNS on the same
  domain, which is fragile. Switching so the same domain both sends and receives natively removed that
  entirely. **Resend's code is deliberately kept, not deleted** (`src/resend.ts`, plus commented-out vars
  in `wrangler.toml` and the `Env` interface) — commented/deprecated only, per explicit instruction, in
  case of rollback.
- **The sending/receiving address is `onboard.ahiapp.ai`, not `radar.ahiapp.ai`.** The original choice
  collided with an unrelated, pre-existing live product already using that subdomain (discovered via
  screenshot after an initial DNS check only looked at mail records and missed the live A/AAAA records
  serving an actual website). Lesson for any future domain check: verify **both** mail records AND
  web/A/AAAA records before treating a subdomain as unused.
- **Wrangler must be v4 (`^4.119.0`), not v3.** v3.114.17 showed the `send_email` binding as valid in its
  startup banner but returned `undefined` at runtime in local dev — a Miniflare support gap, not a code
  bug. Both Workers were upgraded.
- **`CLOUDFLARE_ACCOUNT_ID=ad0e82073fe55145813d96a272b9631f` must be exported before any `wrangler`
  command.** The Cloudflare login has more than one account; wrangler can't auto-select in non-interactive
  mode without this.
- **`/web-intake` is fully synchronous — NOT a fire-and-forget/background pattern.** A prior version
  replied instantly and ran the pipeline in the background via `waitUntil()` for a snappier UI. In real
  production this broke: Cloudflare killed the backgrounded task before it finished
  (`waitUntil() tasks did not complete within the allowed time... and have been cancelled`), so the page
  showed "success" while nothing had actually been saved or sent — confirmed via `wrangler tail` on a
  live request. Fixed by reverting to awaiting the full pipeline before responding — slower (~30-40s),
  but honest. **Do not reintroduce a background/waitUntil pattern for this endpoint** without solving the
  same underlying problem (see §5 — that's exactly what the in-flight work is for).

## 5. In-flight work: moving research onto a real Gemini managed agent

**Not yet started in code** — planning only so far, done in this session (2026-08-07). No branch has
been created yet in the actual repo (still on `main`); this needs a new branch (e.g.
`feat/gemini-managed-agents`) before any of the file changes below begin.

**Why:** two separate problems, one fix. (1) The brief requires genuine Gemini managed agents
(Interactions API) somewhere — today's code just calls plain `generateContent` twice, which doesn't
satisfy that. (2) The synchronous `/web-intake` fix in §4 is honest but slow (~30-40s wait), and the
obvious "make it async" fix is exactly the pattern that already failed once in production.

**Chosen design (poll-only — no webhook):**

```
kick off agent job ──▶ save record as "processing" ──▶ respond to user instantly
        │
        ▼ (Google works on it, on their own servers — we're not waiting)
every ~2 minutes, a Cloudflare Cron Trigger checks every "processing" record:
        │
   still running   →  leave it, check again next round
   done             →  run the existing structuring call → save profile → send draft email
   real error       →  retry with a fresh job, up to 5 total attempts
   hard limit (quota) →  stop immediately, mark "processing_failed", send an apology email
```

A webhook-based design (Google calls us back the instant the job finishes) was considered and
**deliberately dropped** in favor of polling only. Reasoning, in case it comes up again: the polling
logic was needed anyway as a backup for a lost webhook, so building only the backup and skipping the
webhook itself is strictly simpler; the webhook needed verifying a cryptographic signature on an
incoming request whose exact shape has never actually been observed firsthand (docs only); and polling
more often costs nothing extra — Gemini bills these jobs by tokens the agent actually spends thinking/
searching, not by how many times you ask "done yet?" (a status check triggers no new model work).

**One record per company, not several.** Firestore is schemaless, so there's no real cost to starting a
company's one `profiles/{domain}` record with blanks and filling it in as more is learned. Considered
splitting "bare signup" and "researched profile" into two collections; rejected in favor of one record
that just walks through more `status` values: `new` → `processing` → `awaiting_confirmation` →
`confirmed` → `handed_off`, plus `processing_failed`. Per-company logs (`profiles/{domain}/events`) and
message history (`profiles/{domain}/messages`) already exist as subcollections today — that pattern
doesn't change, new step types just get logged into it too.

**Structured output stays a two-step hybrid, not agent-only.** The agent will be told to respond with
JSON directly (fields: `companyName`, `industry`, `size`, `summary`, `sectors`, `keywords`), but a
second plain, schema-constrained Gemini call still tidies whatever comes back — Google's own docs say
structured output isn't guaranteed from an agent, so this stays as cheap insurance rather than trusting
the raw agent output straight into an email.

**Gemini Interactions API shape** (from documentation, not yet confirmed firsthand — verify for real
before trusting these exact field names):
- Create: `POST https://generativelanguage.googleapis.com/v1beta/interactions` with body
  `{ agent: "<agent-id>", input: "<prompt>", background: true }` → returns `{ id, status, created }`.
- Get: `GET https://generativelanguage.googleapis.com/v1beta/interactions/{id}` → returns
  `{ id, status, created, updated, steps: [...] }`.
- Status values seen in docs: `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`,
  `incomplete`, `budget_exceeded`, `queued`.
- Cost: pay-as-you-go by token usage; a single agent job/interaction can reportedly use **100k–3M
  tokens** — notably more than the current two-plain-call approach, since the agent may search/re-check
  itself multiple times. A free tier exists for testing.
- Registering a persistent agent (one-time setup, not per-request) needs its own verification pass —
  example values like `base_agent: "antigravity-preview-05-2026"` and `model: "gemini-3.6-flash"` came
  from docs and have NOT been confirmed to work for this account yet.

**Planned file changes** (none written yet):
- New `apps/agent-service/scripts/sync-agent.mjs` — one-time local script (not deployed) to
  register/verify the persistent agent. Run manually with the key from `.dev.vars`.
- New `apps/agent-service/src/geminiAgent.ts` — `createResearchInteraction(...)`, `getInteraction(...)`.
- `apps/agent-service/src/onboarding.ts` — new `ProfileStatus` values (`processing`,
  `processing_failed`), new `ProfileDoc` fields (`pendingInteractionId`, `retryCount`, `lastError`),
  replace the synchronous research call in `draftAndSaveProfile` with "kick off job, save as
  processing, return," add `reconcilePendingProfiles(env)` implementing the poll/retry/fail logic above,
  and treat a `"processing_failed"` profile like "doesn't exist yet" so a retry email can restart it.
  Also: if a reply arrives while a profile is still `"processing"`, send a "still working on it" note
  instead of trying to process the reply against an unfinished profile.
- `apps/agent-service/src/index.ts` — new `POST /admin/reconcile` (same bearer-token gate as
  `/inbound-email`, for manual testing), new `scheduled()` export wired to `reconcilePendingProfiles`.
- `apps/agent-service/src/firestore.ts` — add `list(collectionPath)`, needed so the reconcile pass can
  scan all `profiles` for anything still `"processing"` (doesn't exist yet — only `get/set/update/add`
  exist today).
- `apps/agent-service/wrangler.toml` — new `GEMINI_AGENT_ID` var, new `[triggers]` cron block (~every 2
  minutes).
- Deliberately **unchanged**: `gemini.ts`'s `draftProfile`/`interpretReply`, `email.ts`,
  `email-template.ts`, `mcp.ts` (the MCP query stays a deterministic, explicit, once-on-confirm step —
  never something the research agent decides to do on its own; the brief frames it as a post-confirmation
  demo touch, not part of research).

**Ordered next steps** (cheapest/safest first, real deploys last):
1. Create and run `sync-agent.mjs` — confirms the agent can register at all, and whether the
   doc-sourced `base_agent`/`model` values are actually correct.
2. Manually create one interaction and poll it by hand a few times against known-good domains — logs a
   real response in full before any other logic is built on assumptions about its shape.
3. Feed that real output into the existing structuring call, confirm the hybrid works end to end.
4. Test the reconcile pass by hand against a faked `"processing"` record — cover still-running, done,
   retryable-error, and hard-limit-error cases.
5. Deploy to a separate, non-demo Worker name first (proves the real Google network path), only then
   touch the actual demo deployment. Every deploy step needs explicit go-ahead regardless (§7).

## 6. Known-resolved issues (don't reopen without new evidence)

- The `waitUntil`/silent-failure bug (§4) — resolved by the synchronous revert. If reintroducing any
  form of "reply fast, keep working after" pattern, it must be the reconcile/polling design in §5, not a
  bare `waitUntil()` — that exact mechanism is what failed in production before.
- DMARC on `onboard.ahiapp.ai` was set to `p=none` (not `p=reject`) deliberately, since the sending
  domain is new/unproven — tightening it later is a policy call, not a bug to "fix."

## 7. Hard rules — apply regardless of which AI tool is reading this

- **Never run `wrangler deploy`, `wrangler pages deploy`, `wrangler secret put`, `git commit`, or
  `git push` without asking the human first** — every time, even mid-task, even if a similar action was
  approved earlier in the same session. Two people deploy pieces of this project independently (marketing
  page vs. backend); an unrequested deploy from either side can clobber the other's in-flight work.
  Editing/writing files locally is fine without asking.
- `WORKER_SHARED_TOKEN` must be identical on both `agent-service` and `email-worker` — it's how they
  authenticate to each other. Never regenerate it on just one side.
- Don't delete deprecated-but-kept code (e.g. `resend.ts`) — comment out / mark deprecated instead,
  unless explicitly told to remove it for good.

## 8. Where to look for more

- `IMPLEMENTATION_PLAN.md` — full architecture, data model, and the detailed "why" behind every
  decision in §4, including a dated resolved-blockers log.
- `CLAUDE.md` — practical deploy commands for all three apps, verified working.
- `apps/agent-service/.dev.vars.example`, `apps/email-worker/.dev.vars.example` — what local secrets
  each Worker expects (copy to `.dev.vars`, gitignored, ask a teammate for real values).
