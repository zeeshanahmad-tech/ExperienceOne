// Outbound email via Cloudflare's native `send_email` Worker binding — replaces the old
// Resend REST client. No API key: the binding is configured directly in wrangler.toml and
// authenticates as part of the platform, since labs@onboard.ahiapp.ai is onboarded for both
// sending and receiving in the same Cloudflare account.
//
// Defined locally rather than pulled from @cloudflare/workers-types, since this binding
// ("Email Sending", Beta) is new enough that the installed types package may not ship it yet.
export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
}

export interface SendEmailOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

export async function sendEmail(emailBinding: SendEmailBinding, opts: SendEmailOptions): Promise<void> {
  const headers: Record<string, string> = {};
  if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
  if (opts.references) headers["References"] = opts.references;

  await emailBinding.send({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    headers: Object.keys(headers).length ? headers : undefined,
  });
}
