import { Hono } from "hono";
import { handleInboundEmail, handleWebIntake, type Env, type InboundEmailPayload } from "./onboarding";

export type { Env };

const app = new Hono<{ Bindings: Env }>();

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

app.post("/web-intake", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email" }, 400);
  }
  try {
    await handleWebIntake(c.env, email);
    return c.json({ ok: true });
  } catch (err) {
    console.error("web-intake failed", err);
    return c.json({ error: "internal_error", detail: String(err) }, 500);
  }
});

export default app;
