import { FirestoreClient } from "./firestore";
import { researchCompany, draftProfile, interpretReply, type DraftProfileFields, type TokenUsage } from "./gemini";
import { sendEmail, type SendEmailBinding, type SendEmailOptions } from "./email";
// Deprecated 2026-08-05 — replaced by ./email (Cloudflare's native send_email binding).
// Kept working, not deleted, in case of rollback. See wrangler.toml for the matching
// commented-out vars.
// import { sendEmail, type SendEmailOptions } from "./resend";
import { queryTenderMcp } from "./mcp";

export interface Env {
  WORKER_SHARED_TOKEN: string;
  GEMINI_API_KEY: string;
  EMAIL: SendEmailBinding;
  AGENT_EMAIL_ADDRESS: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
  AHI_MCP_URL: string;
  // Deprecated 2026-08-05 — see wrangler.toml. Left declared here so restoring the Resend
  // path back doesn't also require re-adding these.
  // RESEND_API_KEY: string;
  // RESEND_SENDING_DOMAIN: string;
  // REPLY_TO_ADDRESS: string;
}

export interface InboundEmailPayload {
  from: string;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}

type ProfileStatus = "draft" | "awaiting_confirmation" | "confirmed" | "handed_off";

interface ProfileDoc {
  domain: string;
  contactEmail: string;
  profile: DraftProfileFields;
  sourceUrls: string[];
  status: ProfileStatus;
  rootMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase().trim() ?? email.toLowerCase().trim();
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Kept in sync with apps/web/index.html's PERSONAL_DOMAINS list — the web form pre-filters
// these client-side, but the server has to enforce it too, or a direct POST bypasses it
// entirely and burns a real Gemini call on an address we can't meaningfully research.
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com",
]);

export function validateWorkEmail(email: string): "invalid_email" | "personal_email" | null {
  if (!VALID_EMAIL.test(email)) return "invalid_email";
  if (PERSONAL_DOMAINS.has(domainOf(email))) return "personal_email";
  return null;
}

function firestoreFor(env: Env): FirestoreClient {
  return new FirestoreClient(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON));
}

async function logEvent(
  db: FirestoreClient,
  domainKey: string,
  type: "inbound_email" | "web_intake" | "gemini_call" | "resend_send" | "mcp_query",
  payloadSummary: string,
  ok: boolean,
  tokenUsage?: TokenUsage
): Promise<void> {
  await db.add(`profiles/${domainKey}/events`, {
    type,
    payloadSummary,
    ok,
    ...(tokenUsage ? { tokenUsage } : {}),
    createdAt: new Date().toISOString(),
  });
}

/** Every Gemini call goes through here so token usage and failures both always get logged, not just successes. */
async function callGeminiLogged<T extends { usage: TokenUsage }>(
  db: FirestoreClient,
  domainKey: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const result = await fn();
    await logEvent(db, domainKey, "gemini_call", label, true, result.usage);
    return result;
  } catch (err) {
    await logEvent(db, domainKey, "gemini_call", `${label} failed: ${String(err)}`, false);
    throw err;
  }
}

/** Every outbound email goes through here so the event log tells the whole story, not just the Gemini half of it. */
async function sendEmailLogged(db: FirestoreClient, domainKey: string, label: string, emailBinding: SendEmailBinding, opts: SendEmailOptions): Promise<void> {
  try {
    await sendEmail(emailBinding, opts);
    await logEvent(db, domainKey, "resend_send", label, true);
  } catch (err) {
    await logEvent(db, domainKey, "resend_send", `${label} failed: ${String(err)}`, false);
    throw err;
  }
}

async function recordMessage(
  db: FirestoreClient,
  domainKey: string,
  direction: "inbound" | "outbound",
  fields: { from: string; subject: string | null; bodyExcerpt: string; messageId: string | null; inReplyTo: string | null }
): Promise<void> {
  await db.add(`profiles/${domainKey}/messages`, {
    direction,
    ...fields,
    createdAt: new Date().toISOString(),
  });
}

async function draftAndSaveProfile(db: FirestoreClient, env: Env, domainKey: string, contactEmail: string, rootMessageId: string | null): Promise<ProfileDoc> {
  const research = await callGeminiLogged(db, domainKey, `researchCompany(${domainKey})`, () =>
    researchCompany(env.GEMINI_API_KEY, domainKey)
  );
  const drafted = await callGeminiLogged(db, domainKey, `draftProfile(${domainKey})`, () =>
    draftProfile(env.GEMINI_API_KEY, domainKey, research)
  );

  const doc: ProfileDoc = {
    domain: domainKey,
    contactEmail,
    profile: drafted.profile,
    sourceUrls: research.sourceUrls,
    status: "awaiting_confirmation",
    rootMessageId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.set(`profiles/${domainKey}`, doc as unknown as Record<string, unknown>);
  return doc;
}

function formatProfileForEmail(profile: DraftProfileFields): string {
  const lines: string[] = [];
  if (profile.companyName) lines.push(`Company: ${profile.companyName}`);
  if (profile.industry) lines.push(`Industry: ${profile.industry}`);
  if (profile.size) lines.push(`Size: ${profile.size}`);
  if (profile.summary) lines.push(`\n${profile.summary}`);
  if (profile.sectors?.length) lines.push(`\nSectors of interest: ${profile.sectors.join(", ")}`);
  if (profile.keywords?.length) lines.push(`Keywords: ${profile.keywords.join(", ")}`);
  return lines.length ? lines.join("\n") : "We couldn't find much public information about your company yet — feel free to fill in the gaps yourself.";
}

async function sendDraftEmail(db: FirestoreClient, env: Env, doc: ProfileDoc, opts: { inReplyTo?: string; references?: string }) {
  const body =
    `Here's what we found about your company:\n\n${formatProfileForEmail(doc.profile)}\n\n` +
    `Reply to this email to confirm it's right, or tell us what to change.`;
  await sendEmailLogged(db, doc.domain, `draft profile to ${doc.contactEmail}`, env.EMAIL, {
    from: env.AGENT_EMAIL_ADDRESS,
    to: doc.contactEmail,
    subject: "Here's what we found about your company",
    text: body,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
}

/** Web front door — same enrichment path, entered from the marketing page instead of an inbound email. */
export async function handleWebIntake(env: Env, email: string): Promise<void> {
  const domainKey = domainOf(email);
  const db = firestoreFor(env);

  const existing = await db.get(`profiles/${domainKey}`);
  if (existing) return; // already onboarded or in progress — don't restart the flow

  const doc = await draftAndSaveProfile(db, env, domainKey, email, null);
  await sendDraftEmail(db, env, doc, {});
  await logEvent(db, domainKey, "web_intake", `web intake for ${email}`, true);
}

/** The core mechanic: inbound email, cold or forwarded, keyed only off the sender's domain. */
export async function handleInboundEmail(env: Env, payload: InboundEmailPayload): Promise<void> {
  const domainKey = domainOf(payload.from);
  const db = firestoreFor(env);

  await recordMessage(db, domainKey, "inbound", {
    from: payload.from,
    subject: payload.subject,
    bodyExcerpt: (payload.text ?? "").slice(0, 2000),
    messageId: payload.messageId,
    inReplyTo: payload.inReplyTo,
  });
  await logEvent(db, domainKey, "inbound_email", `from ${payload.from}: ${payload.subject ?? "(no subject)"}`, true);

  const existing = (await db.get(`profiles/${domainKey}`)) as ProfileDoc | null;

  // No profile yet for this domain — brand new, or a cold forward with zero prior context.
  // Either way, the domain is the only anchor we trust; start the flow fresh.
  if (!existing) {
    const doc = await draftAndSaveProfile(db, env, domainKey, payload.from, payload.messageId);
    await sendDraftEmail(db, env, doc, { inReplyTo: payload.messageId ?? undefined, references: payload.messageId ?? undefined });
    return;
  }

  if (existing.status === "handed_off" || existing.status === "confirmed") {
    // Already done — for hackathon scope, just acknowledge rather than re-running the whole flow.
    await sendEmailLogged(db, domainKey, `already-confirmed ack to ${payload.from}`, env.EMAIL, {
      from: env.AGENT_EMAIL_ADDRESS,
      to: payload.from,
      subject: `Re: ${payload.subject ?? "your profile"}`,
      text: "Thanks for the note — your profile is already confirmed and set up. We'll be in touch with your first report.",
      inReplyTo: payload.messageId ?? undefined,
    });
    return;
  }

  // Reply in the confirm/refine loop.
  const { interpretation } = await callGeminiLogged(db, domainKey, `interpretReply(${domainKey})`, () =>
    interpretReply(env.GEMINI_API_KEY, existing.profile, payload.text ?? "")
  );

  if (interpretation.intent === "edit" && interpretation.updates) {
    const mergedProfile: DraftProfileFields = { ...existing.profile, ...interpretation.updates };
    await db.update(`profiles/${domainKey}`, { profile: mergedProfile, updatedAt: new Date().toISOString() });
    await sendEmailLogged(db, domainKey, `edit reply to ${payload.from}`, env.EMAIL, {
      from: env.AGENT_EMAIL_ADDRESS,
      to: payload.from,
      subject: `Re: ${payload.subject ?? "your profile"}`,
      text: `${interpretation.replyMessage}\n\nUpdated profile:\n\n${formatProfileForEmail(mergedProfile)}\n\nReply to confirm, or keep refining.`,
      inReplyTo: payload.messageId ?? undefined,
      references: payload.messageId ?? undefined,
    });
    return;
  }

  if (interpretation.intent === "confirm") {
    await db.update(`profiles/${domainKey}`, { status: "confirmed", updatedAt: new Date().toISOString() });

    let handoffNote = "";
    try {
      const mcpResult = await queryTenderMcp(env.AHI_MCP_URL, existing.profile.keywords ?? []);
      await logEvent(db, domainKey, "mcp_query", `demo query with keywords=${(existing.profile.keywords ?? []).join(",")}`, true);
      handoffNote = mcpResult ? "\n\nAs a preview, we already found some relevant tenders based on your profile — your first full report is on its way." : "";
    } catch (err) {
      await logEvent(db, domainKey, "mcp_query", `demo query failed: ${String(err)}`, false);
    }

    await db.update(`profiles/${domainKey}`, { status: "handed_off", updatedAt: new Date().toISOString() });
    await sendEmailLogged(db, domainKey, `handoff confirmation to ${payload.from}`, env.EMAIL, {
      from: env.AGENT_EMAIL_ADDRESS,
      to: payload.from,
      subject: `Re: ${payload.subject ?? "your profile"}`,
      text: `${interpretation.replyMessage}${handoffNote}`,
      inReplyTo: payload.messageId ?? undefined,
      references: payload.messageId ?? undefined,
    });
    return;
  }

  // unclear
  await sendEmailLogged(db, domainKey, `clarifying reply to ${payload.from}`, env.EMAIL, {
    from: env.AGENT_EMAIL_ADDRESS,
    to: payload.from,
    subject: `Re: ${payload.subject ?? "your profile"}`,
    text: interpretation.replyMessage,
    inReplyTo: payload.messageId ?? undefined,
    references: payload.messageId ?? undefined,
  });
}
