// Client for the Gemini Interactions API — creating a managed-agent job that runs in the
// background on Google's side, and checking on it later. Field names here are sourced from
// documentation, not yet confirmed against a real response. The first real test (running
// scripts/sync-agent.mjs, then creating one interaction and polling it by hand) should log a
// full raw response before any of this parsing logic is trusted — see IMPLEMENTATION_PLAN.md.

const INTERACTIONS_BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";

export interface InteractionRef {
  id: string;
  status: string;
}

export async function createResearchInteraction(apiKey: string, agentId: string, domain: string): Promise<InteractionRef> {
  const res = await fetch(INTERACTIONS_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      agent: agentId,
      input: `Research the company that owns the email domain "${domain}".`,
      background: true,
    }),
  });
  if (!res.ok) throw new Error(`Create interaction failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; status: string };
  return { id: json.id, status: json.status };
}

export interface InteractionResult {
  id: string;
  status: string;
  raw: any;
}

export async function getInteraction(apiKey: string, id: string): Promise<InteractionResult> {
  const res = await fetch(`${INTERACTIONS_BASE}/${id}`, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Get interaction failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; status: string };
  return { id: json.id, status: json.status, raw: json };
}

export type InteractionOutcome = "running" | "done" | "retryable_error" | "hard_limit";

/**
 * "incomplete" (agent hit its own token budget) and "requires_action" (agent wants something we
 * don't support, since our agent only has google_search) are both treated as retryable rather than
 * building out the continuation/resume flow those really call for — good enough for hackathon scope.
 * "budget_exceeded" is treated as the hard limit (retrying a quota problem immediately just burns
 * attempts for nothing). Any status not seen in docs falls back to retryable rather than hanging forever.
 */
export function classifyInteractionStatus(status: string): InteractionOutcome {
  switch (status) {
    case "queued":
    case "in_progress":
      return "running";
    case "completed":
      return "done";
    case "budget_exceeded":
      return "hard_limit";
    case "failed":
    case "cancelled":
    case "incomplete":
    case "requires_action":
      return "retryable_error";
    default:
      return "retryable_error";
  }
}

/** Pulls the agent's final free-text answer out of a completed interaction. */
export function extractInteractionText(interaction: InteractionResult): string {
  const raw = interaction.raw;
  if (typeof raw.output_text === "string" && raw.output_text.trim()) return raw.output_text;

  const steps: any[] = Array.isArray(raw.steps) ? raw.steps : [];
  const parts: string[] = [];
  for (const step of steps) {
    const stepParts = step?.content?.parts ?? step?.output?.parts ?? [];
    for (const part of stepParts) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** Best-effort — grounding chunk shape for agent search steps hasn't been confirmed firsthand. */
export function extractInteractionSourceUrls(interaction: InteractionResult): string[] {
  const raw = interaction.raw;
  const steps: any[] = Array.isArray(raw.steps) ? raw.steps : [];
  const urls = new Set<string>();
  for (const step of steps) {
    const chunks = step?.grounding_metadata?.grounding_chunks ?? step?.groundingMetadata?.groundingChunks ?? [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      if (uri) urls.add(uri);
    }
  }
  return [...urls];
}

/** Human-readable token usage for the event log — real field names unconfirmed, hence the fallback. */
export function extractInteractionUsageSummary(interaction: InteractionResult): string {
  const usage = interaction.raw?.usage;
  if (!usage) return "usage unknown";
  const total = usage.total_tokens ?? usage.totalTokenCount ?? "?";
  return `${total} total tokens`;
}
