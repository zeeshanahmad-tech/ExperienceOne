// One-time (re-runnable) local script to register the persistent Gemini managed agent used for
// company research. Not deployed — run manually from a machine with a real Gemini API key:
//
//   node scripts/sync-agent.mjs
//
// Reads GEMINI_API_KEY from .dev.vars in this same directory (gitignored, never committed).
// There's no update/patch endpoint for an existing agent's config, so "sync" here means:
// delete-then-recreate if the agent already exists, so re-running after tweaking the
// instructions below always converges to the latest desired state.
//
// First real thing this proves: whether base_agent/model values from Google's docs are actually
// valid for this account. If this errors, that's the answer — adjust AGENT_CONFIG and re-run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars() {
  const path = join(__dirname, "..", ".dev.vars");
  const text = readFileSync(path, "utf8");
  const vars = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const { GEMINI_API_KEY } = loadDevVars();
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not found in apps/agent-service/.dev.vars");
  process.exit(1);
}

const AGENT_ID = "exp1-company-researcher";
const AGENTS_BASE = "https://generativelanguage.googleapis.com/v1beta/agents";

const AGENT_CONFIG = {
  id: AGENT_ID,
  base_agent: "antigravity-preview-05-2026",
  agent_config: { type: "antigravity", model: "gemini-3.6-flash" },
  description: "Researches the company behind an email domain for Experience 1 onboarding.",
  // Explicitly override the default tool set (code_execution, google_search, url_context) down
  // to just google_search — this agent should never execute code or fetch arbitrary URLs, and
  // must never get the AHI MCP tool (that stays a deterministic, explicit, once-on-confirm step).
  tools: [{ google_search: {} }],
  system_instruction:
    "You are a company research assistant for a tender/grant-matching service. Given an email " +
    "domain, research the company that owns it — what it does, its industry, approximate size, " +
    "and what kinds of public tenders or grants it might realistically be interested in. Search " +
    "as many times as you judge necessary; don't stop after one query if results are thin. Only " +
    "report facts you actually find; if you find nothing concrete, say so plainly rather than " +
    "guessing. Respond with a single JSON object with fields companyName, industry, size, " +
    "summary, sectors, keywords — no text before or after the JSON.",
};

async function getExistingAgent() {
  const res = await fetch(`${AGENTS_BASE}/${AGENT_ID}`, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET agent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteAgent() {
  const res = await fetch(`${AGENTS_BASE}/${AGENT_ID}`, { method: "DELETE", headers: { "x-goog-api-key": GEMINI_API_KEY } });
  if (!res.ok) throw new Error(`DELETE agent failed: ${res.status} ${await res.text()}`);
}

async function createAgent() {
  const res = await fetch(AGENTS_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(AGENT_CONFIG),
  });
  if (!res.ok) throw new Error(`CREATE agent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const existing = await getExistingAgent();
if (existing) {
  console.log(`Agent "${AGENT_ID}" already exists — deleting and recreating with current config.`);
  await deleteAgent();
} else {
  console.log(`Agent "${AGENT_ID}" doesn't exist yet — creating.`);
}

const created = await createAgent();
console.log("Created agent:");
console.log(JSON.stringify(created, null, 2));
console.log(`\nSet GEMINI_AGENT_ID = "${AGENT_ID}" in wrangler.toml (already done if you're using the default id above).`);
