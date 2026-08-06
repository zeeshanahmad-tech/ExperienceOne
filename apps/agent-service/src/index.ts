import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleInboundEmail, handleWebIntake, validateWorkEmail, type Env, type InboundEmailPayload } from "./onboarding";

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

// Contract (matches apps/web/index.html): POST { email } → 202 { ok: true } | 400 { ok: false, error }
// Acknowledge INSTANTLY, then run the slow work (Gemini enrichment + Resend send)
// in the background with waitUntil — otherwise the browser sits on a spinner for
// the whole pipeline. Validation stays synchronous so a bad / personal email still
// gets an immediate 400; only the accepted path is backgrounded.
app.post("/web-intake", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  const error = validateWorkEmail(email ?? "");
  if (error) {
    return c.json({ ok: false, error }, 400);
  }
  c.executionCtx.waitUntil(
    handleWebIntake(c.env, email).catch((err) =>
      console.error("web-intake background failed", err)
    )
  );
  return c.json({ ok: true }, 202);
});

export default app;
