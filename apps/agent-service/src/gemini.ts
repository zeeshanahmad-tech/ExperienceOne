// Gemini API client. Two-call design because the API doesn't allow combining
// the google_search grounding tool with structured JSON output in one call —
// so step 1 researches (grounded, free text), step 2 structures that text into JSON.

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface TokenUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  toolUsePromptTokenCount: number;
  totalTokenCount: number;
}

function extractUsage(result: any): TokenUsage {
  const u = result.usageMetadata ?? {};
  return {
    promptTokenCount: u.promptTokenCount ?? 0,
    candidatesTokenCount: u.candidatesTokenCount ?? 0,
    toolUsePromptTokenCount: u.toolUsePromptTokenCount ?? 0,
    totalTokenCount: u.totalTokenCount ?? 0,
  };
}

async function callGemini(apiKey: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini call failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export interface CompanyResearch {
  text: string;
  sourceUrls: string[];
  usage: TokenUsage;
}

export async function researchCompany(apiKey: string, domain: string): Promise<CompanyResearch> {
  const result = await callGemini(apiKey, {
    contents: [
      {
        parts: [
          {
            text:
              `Research the company that owns the email domain "${domain}". ` +
              `Find what the company does, its industry, approximate size, and any public information about the kind ` +
              `of public tenders, contracts, or grants it might realistically be interested in. Be factual — only report ` +
              `what you actually find via search. If you can't find anything concrete about this specific domain/company, ` +
              `say so plainly rather than guessing.`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  });

  const candidate = result.candidates?.[0];
  const text: string = (candidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("\n");
  const sourceUrls: string[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c: { web?: { uri?: string } }) => c.web?.uri)
    .filter((u: string | undefined): u is string => Boolean(u));

  return { text, sourceUrls, usage: extractUsage(result) };
}

const PROFILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyName: { type: "STRING", nullable: true },
    industry: { type: "STRING", nullable: true },
    size: { type: "STRING", nullable: true },
    summary: { type: "STRING", nullable: true },
    sectors: { type: "ARRAY", items: { type: "STRING" } },
    keywords: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["sectors", "keywords"],
};

export interface DraftProfileFields {
  companyName: string | null;
  industry: string | null;
  size: string | null;
  summary: string | null;
  sectors: string[];
  keywords: string[];
}

export interface DraftProfileResult {
  profile: DraftProfileFields;
  usage: TokenUsage;
}

export async function draftProfile(apiKey: string, domain: string, research: CompanyResearch): Promise<DraftProfileResult> {
  const result = await callGemini(apiKey, {
    contents: [
      {
        parts: [
          {
            text:
              `Based on this research about the company at domain "${domain}":\n\n${research.text}\n\n` +
              `Produce a structured company + interest profile. Only include facts actually present in the research above — ` +
              `never invent numbers or details. If the research found nothing concrete, leave fields null or empty rather ` +
              `than guessing.`,
          },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", responseSchema: PROFILE_SCHEMA },
  });
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return { profile: JSON.parse(text), usage: extractUsage(result) };
}

const REPLY_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: ["confirm", "edit", "unclear"] },
    updates: {
      type: "OBJECT",
      properties: {
        companyName: { type: "STRING", nullable: true },
        industry: { type: "STRING", nullable: true },
        size: { type: "STRING", nullable: true },
        summary: { type: "STRING", nullable: true },
        sectors: { type: "ARRAY", items: { type: "STRING" } },
        keywords: { type: "ARRAY", items: { type: "STRING" } },
      },
    },
    replyMessage: { type: "STRING" },
  },
  required: ["intent", "replyMessage"],
};

export interface ReplyInterpretation {
  intent: "confirm" | "edit" | "unclear";
  updates?: Partial<DraftProfileFields>;
  replyMessage: string;
}

export interface ReplyInterpretationResult {
  interpretation: ReplyInterpretation;
  usage: TokenUsage;
}

export async function interpretReply(
  apiKey: string,
  currentProfile: DraftProfileFields,
  replyText: string
): Promise<ReplyInterpretationResult> {
  const result = await callGemini(apiKey, {
    contents: [
      {
        parts: [
          {
            text:
              `Current draft profile:\n${JSON.stringify(currentProfile, null, 2)}\n\n` +
              `The user replied:\n"""${replyText}"""\n\n` +
              `Classify their intent: "confirm" (happy with the profile as-is — e.g. "yes", "looks good", "confirmed"), ` +
              `"edit" (wants to correct or add something — extract only the specific fields they addressed into "updates"), ` +
              `or "unclear" (doesn't clearly indicate either). Write a short, natural "replyMessage" — one or two sentences ` +
              `we should send back (a clarifying question if unclear, a friendly confirmation if confirmed, or an updated ` +
              `summary if edited).`,
          },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", responseSchema: REPLY_SCHEMA },
  });
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return { interpretation: JSON.parse(text), usage: extractUsage(result) };
}
