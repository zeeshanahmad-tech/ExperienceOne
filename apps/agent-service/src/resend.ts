export interface SendEmailOptions {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

export async function sendEmail(apiKey: string, opts: SendEmailOptions): Promise<{ id: string }> {
  const headers: Record<string, string> = {};
  if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
  if (opts.references) headers["References"] = opts.references;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      reply_to: opts.replyTo,
      subject: opts.subject,
      text: opts.text,
      headers: Object.keys(headers).length ? headers : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
