import PostalMime from "postal-mime";

export interface Env {
  AGENT_SERVICE_URL: string;
  WORKER_SHARED_TOKEN: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const parsed = await PostalMime.parse(message.raw);

    const payload = {
      from: message.from,
      to: message.to,
      subject: parsed.subject ?? null,
      text: parsed.text ?? null,
      html: parsed.html ?? null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
    };

    const response = await fetch(`${env.AGENT_SERVICE_URL}/inbound-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.WORKER_SHARED_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Cloudflare Email Routing has no built-in retry visibility beyond this — surfacing
      // as a worker exception at least gets it into the Workers log tail.
      throw new Error(`agent-service /inbound-email failed: ${response.status}`);
    }
  },
};
