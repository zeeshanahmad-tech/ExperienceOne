import { FirestoreClient } from "./firestore";
import { draftProfile, interpretReply, type CompanyResearch, type DraftProfileFields, type TokenUsage } from "./gemini";
import {
  createResearchInteraction,
  getInteraction,
  classifyInteractionStatus,
  extractInteractionText,
  extractInteractionSourceUrls,
  extractInteractionUsageSummary,
  type InteractionResult,
} from "./geminiAgent";
import { sendEmail, type SendEmailBinding, type SendEmailOptions } from "./email";
// Deprecated 2026-08-05 — replaced by ./email (Cloudflare's native send_email binding).
// Kept working, not deleted, in case of rollback. See wrangler.toml for the matching
// commented-out vars.
// import { sendEmail, type SendEmailOptions } from "./resend";
import { queryTenderMcp } from "./mcp";

export interface Env {
  WORKER_SHARED_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI_AGENT_ID: string;
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

// "processing": research job handed off, waiting on a check-in (see reconcilePendingProfiles) to
// find it done. "processing_failed": retried the maximum number of times, or hit a hard limit,
// and the user's already been told — not left hanging. Treated like "doesn't exist yet" by the
// intake guards below, so a fresh email can restart a failed attempt.
type ProfileStatus = "processing" | "awaiting_confirmation" | "confirmed" | "handed_off" | "processing_failed";

const MAX_RESEARCH_RETRIES = 5;

interface ProfileDoc {
  domain: string;
  contactEmail: string;
  profile: DraftProfileFields | null;
  sourceUrls: string[];
  status: ProfileStatus;
  pendingInteractionId: string | null;
  retryCount: number;
  lastError: string | null;
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

/**
 * Kicks off the research agent job and saves a "processing" record — does NOT wait for research
 * to finish. The actual draft (structuring the agent's findings + emailing it) happens later,
 * from reconcilePendingProfiles, once the job is done. This is what lets both /web-intake and
 * /inbound-email respond quickly instead of blocking for however long research takes.
 */
async function startResearch(db: FirestoreClient, env: Env, domainKey: string, contactEmail: string, rootMessageId: string | null): Promise<ProfileDoc> {
  let interactionId: string;
  try {
    const interaction = await createResearchInteraction(env.GEMINI_API_KEY, env.GEMINI_AGENT_ID, domainKey);
    interactionId = interaction.id;
    await logEvent(db, domainKey, "gemini_call", `createResearchInteraction(${domainKey}) -> ${interactionId}`, true);
  } catch (err) {
    await logEvent(db, domainKey, "gemini_call", `createResearchInteraction(${domainKey}) failed: ${String(err)}`, false);
    throw err;
  }

  const doc: ProfileDoc = {
    domain: domainKey,
    contactEmail,
    profile: null,
    sourceUrls: [],
    status: "processing",
    pendingInteractionId: interactionId,
    retryCount: 0,
    lastError: null,
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

/** Only ever called once research has completed and `doc.profile` is populated. */
async function sendDraftEmail(db: FirestoreClient, env: Env, doc: ProfileDoc, opts: { inReplyTo?: string; references?: string }) {
  const profile = doc.profile!;
  const body =
    `Here's what we found about your company:\n\n${formatProfileForEmail(profile)}\n\n` +
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

/** Runs once a research job's interaction has reached "completed" — structures the agent's free
 * text into our exact profile shape (the safety net the agent's own JSON instruction isn't
 * guaranteed to satisfy), saves the profile, and sends the draft. */
async function completeResearch(db: FirestoreClient, env: Env, domainKey: string, doc: ProfileDoc, interaction: InteractionResult): Promise<void> {
  const text = extractInteractionText(interaction);
  await logEvent(db, domainKey, "gemini_call", `agent research for ${domainKey} completed (${extractInteractionUsageSummary(interaction)})`, true);

  const research: CompanyResearch = {
    text,
    sourceUrls: extractInteractionSourceUrls(interaction),
    usage: { promptTokenCount: 0, candidatesTokenCount: 0, toolUsePromptTokenCount: 0, totalTokenCount: 0 },
  };
  const drafted = await callGeminiLogged(db, domainKey, `draftProfile(${domainKey})`, () => draftProfile(env.GEMINI_API_KEY, domainKey, research));

  const updated: ProfileDoc = {
    ...doc,
    profile: drafted.profile,
    sourceUrls: research.sourceUrls,
    status: "awaiting_confirmation",
    pendingInteractionId: null,
    updatedAt: new Date().toISOString(),
  };
  await db.set(`profiles/${domainKey}`, updated as unknown as Record<string, unknown>);
  await sendDraftEmail(db, env, updated, { inReplyTo: doc.rootMessageId ?? undefined, references: doc.rootMessageId ?? undefined });
}

/**
 * A research job ended badly (real error) or hit a hard limit (quota). Hard limits and
 * exhausted retries both give up immediately and tell the user; anything else retries with a
 * fresh job, up to MAX_RESEARCH_RETRIES. Returns true if the profile was marked failed.
 */
async function handleResearchFailure(db: FirestoreClient, env: Env, domainKey: string, doc: ProfileDoc, reason: string, isHardLimit: boolean): Promise<boolean> {
  await logEvent(db, domainKey, "gemini_call", `research for ${domainKey} ${reason}`, false);

  const nextRetryCount = doc.retryCount + 1;
  if (isHardLimit || nextRetryCount > MAX_RESEARCH_RETRIES) {
    await db.update(`profiles/${domainKey}`, {
      status: "processing_failed",
      lastError: reason,
      updatedAt: new Date().toISOString(),
    });
    await sendEmailLogged(db, domainKey, `research-failed apology to ${doc.contactEmail}`, env.EMAIL, {
      from: env.AGENT_EMAIL_ADDRESS,
      to: doc.contactEmail,
      subject: "We hit a snag putting your profile together",
      text: "Something went wrong while researching your company, and we weren't able to finish. Reply to this email (or send a new one) and we'll try again.",
    });
    return true;
  }

  try {
    const interaction = await createResearchInteraction(env.GEMINI_API_KEY, env.GEMINI_AGENT_ID, domainKey);
    await db.update(`profiles/${domainKey}`, {
      pendingInteractionId: interaction.id,
      retryCount: nextRetryCount,
      lastError: reason,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Couldn't even start the retry — leave retryCount as-is so the next check-in tries again
    // instead of silently losing this profile.
    await logEvent(db, domainKey, "gemini_call", `retry ${nextRetryCount} for ${domainKey} failed to start: ${String(err)}`, false);
  }
  return false;
}

/**
 * Runs on a timer (see index.ts's scheduled() export). Looks at every profile still "processing"
 * and checks in on its research job — this is the ONLY way completion is detected, there's no
 * webhook. See IMPLEMENTATION_PLAN.md / the plan doc for why polling-only was chosen over a
 * webhook+backup design.
 */
export async function reconcilePendingProfiles(env: Env): Promise<{ checked: number; completed: number; retried: number; failed: number }> {
  const db = firestoreFor(env);
  const all = await db.list("profiles");
  const pending = all.filter((p) => (p.data as unknown as ProfileDoc).status === "processing");

  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const { id: domainKey, data } of pending) {
    const doc = data as unknown as ProfileDoc;
    if (!doc.pendingInteractionId) {
      await logEvent(db, domainKey, "gemini_call", `${domainKey} is "processing" with no pendingInteractionId — skipping`, false);
      continue;
    }

    let interaction: InteractionResult;
    try {
      interaction = await getInteraction(env.GEMINI_API_KEY, doc.pendingInteractionId);
    } catch (err) {
      // Transient hiccup checking status, not the job's own failure — try again next round.
      await logEvent(db, domainKey, "gemini_call", `getInteraction(${doc.pendingInteractionId}) failed: ${String(err)}`, false);
      continue;
    }

    const outcome = classifyInteractionStatus(interaction.status);
    if (outcome === "running") continue;

    if (outcome === "done") {
      try {
        await completeResearch(db, env, domainKey, doc, interaction);
        completed++;
      } catch (err) {
        // Research itself succeeded but structuring/saving/emailing failed — still retryable.
        await handleResearchFailure(db, env, domainKey, doc, `post-completion step failed: ${String(err)}`, false);
        retried++;
      }
      continue;
    }

    const isHardLimit = outcome === "hard_limit";
    const gaveUp = await handleResearchFailure(
      db, env, domainKey, doc,
      `interaction ${doc.pendingInteractionId} ended with status "${interaction.status}"`,
      isHardLimit
    );
    if (gaveUp) failed++; else retried++;
  }

  return { checked: pending.length, completed, retried, failed };
}

/** Web front door — same enrichment path, entered from the marketing page instead of an inbound email. */
export async function handleWebIntake(env: Env, email: string): Promise<void> {
  const domainKey = domainOf(email);
  const db = firestoreFor(env);

  const existing = (await db.get(`profiles/${domainKey}`)) as ProfileDoc | null;
  // A "processing_failed" record is treated like "doesn't exist yet" — a fresh submission gets
  // to retry rather than being permanently stuck on one failed attempt.
  if (existing && existing.status !== "processing_failed") return;

  await startResearch(db, env, domainKey, email, null);
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

  // No usable profile yet for this domain — brand new, a cold forward with zero prior context,
  // or a previous attempt that failed. Either way, the domain is the only anchor we trust; start fresh.
  if (!existing || existing.status === "processing_failed") {
    await startResearch(db, env, domainKey, payload.from, payload.messageId);
    return; // no email sent yet — reconcilePendingProfiles sends the draft once research completes
  }

  if (existing.status === "processing") {
    // The job might genuinely still be running when someone replies (wasn't possible before, when
    // everything ran synchronously) — don't try to interpret a reply against an unfinished profile.
    await sendEmailLogged(db, domainKey, `still-processing ack to ${payload.from}`, env.EMAIL, {
      from: env.AGENT_EMAIL_ADDRESS,
      to: payload.from,
      subject: `Re: ${payload.subject ?? "your profile"}`,
      text: "Still putting your profile together — we'll follow up shortly with what we found.",
      inReplyTo: payload.messageId ?? undefined,
    });
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

  // Reply in the confirm/refine loop — only reachable once research has finished (guards above
  // handle processing/processing_failed/handed_off/confirmed), so profile is always populated here.
  const profile = existing.profile!;
  const { interpretation } = await callGeminiLogged(db, domainKey, `interpretReply(${domainKey})`, () =>
    interpretReply(env.GEMINI_API_KEY, profile, payload.text ?? "")
  );

  if (interpretation.intent === "edit" && interpretation.updates) {
    const mergedProfile: DraftProfileFields = { ...profile, ...interpretation.updates };
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
      const mcpResult = await queryTenderMcp(env.AHI_MCP_URL, profile.keywords ?? []);
      await logEvent(db, domainKey, "mcp_query", `demo query with keywords=${(profile.keywords ?? []).join(",")}`, true);
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
