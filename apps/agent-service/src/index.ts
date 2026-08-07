import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  handleInboundEmail,
  handleWebIntake,
  reconcilePendingProfiles,
  validateWorkEmail,
  type Env,
  type InboundEmailPayload,
} from "./onboarding";

export type { Env };

const app = new Hono<{ Bindings: Env }>();

// The marketing page calls /web-intake from the browser, on a different origin
// (Cloudflare Pages) than this Worker — needs CORS. /inbound-email is server-to-server
// only (email-worker → here) and already bearer-token gated, so this is harmless there too.
app.use("*", cors());

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/inbound-email", async (c) => {
  const token = c.req.header("authorization")?.replace("Bearer ", "");
  if (token !== c.env.WORKER_SHARED_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const payload = await c.req.json<InboundEmailPayload>();
  try {
    await handleInboundEmail(c.env, payload);
    return c.json({ ok: true });
  } catch (err) {
    console.error("inbound-email failed", err);
    return c.json({ error: "internal_error", detail: String(err) }, 500);
  }
});

// Contract (matches apps/web/index.html): POST { email } → 202 { ok: true } | 400/500 { ok: false, error }
// Reverted to synchronous 2026-08-06 — a prior version acknowledged instantly and ran the
// pipeline in the background via waitUntil for a snappier UI, but that broke in production:
// Cloudflare killed the backgrounded task before it finished ("waitUntil() tasks did not
// complete within the allowed time"), so the page showed success while nothing actually
// happened — no profile saved, no email sent, no error surfaced anywhere. A slower response
// that's honest about the real outcome beats a fast one that silently lies about it.
app.post("/web-intake", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  const error = validateWorkEmail(email ?? "");
  if (error) {
    return c.json({ ok: false, error }, 400);
  }
  try {
    await handleWebIntake(c.env, email);
    return c.json({ ok: true }, 202);
  } catch (err) {
    console.error("web-intake failed", err);
    return c.json({ ok: false, error: "internal_error", detail: String(err) }, 500);
  }
});

// Manual trigger for the check-in pass — same bearer-token gate as /inbound-email — so it can be
// tested on demand instead of waiting for the real cron schedule.
app.post("/admin/reconcile", async (c) => {
  const token = c.req.header("authorization")?.replace("Bearer ", "");
  if (token !== c.env.WORKER_SHARED_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const result = await reconcilePendingProfiles(c.env);
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("reconcile failed", err);
    return c.json({ error: "internal_error", detail: String(err) }, 500);
  }
});

export default {
  fetch: app.fetch,
  // Runs automatically on the cron schedule in wrangler.toml — checks every "processing"
  // profile's research job and finishes, retries, or fails it. No webhook involved; see
  // IMPLEMENTATION_PLAN.md for why polling-only was chosen.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcilePendingProfiles(env).catch((err) => console.error("scheduled reconcile failed", err))
    );
  },
};
