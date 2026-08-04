import Fastify from "fastify";

const app = Fastify({ logger: true });

// Liveness/readiness probe for Cloud Run.
app.get("/healthz", async () => ({ ok: true }));

// Called by the Cloudflare email-worker with parsed MIME fields + headers.
// TODO: domain/thread matching (see IMPLEMENTATION_PLAN.md §4), Gemini enrichment call,
// Firestore read/write, Resend send.
app.post("/inbound-email", async (request, reply) => {
  const token = request.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.WORKER_SHARED_TOKEN) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return reply.code(501).send({ error: "not implemented" });
});

// Called by the web marketing page with just an email address.
// TODO: same enrichment path as /inbound-email, entered from the web front door.
app.post("/web-intake", async (_request, reply) => {
  return reply.code(501).send({ error: "not implemented" });
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
