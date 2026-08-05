// Minimal MCP (Streamable HTTP transport) client for the AHI Tender Search MCP.
// Confirmed live and unauthenticated 2026-08-04: a plain JSON-RPC POST gets a
// proper `initialize` handshake back, no credentials needed.

async function mcpRequest(url: string, body: unknown, sessionId?: string): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get("mcp-session-id");
  const raw = await res.text();
  // Streamable HTTP responses arrive as SSE ("event: message\ndata: {...}") or plain JSON.
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const payload = dataLine ? dataLine.slice("data:".length).trim() : raw;
  const parsed = JSON.parse(payload) as { result?: unknown; error?: unknown };
  if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  return { result: parsed.result, sessionId: newSessionId };
}

/** One light demo query proving the handoff to Experience 2 — not a search feature. */
export async function queryTenderMcp(mcpUrl: string, keywords: string[]): Promise<unknown> {
  const init = await mcpRequest(mcpUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "experience-one-agent", version: "1.0.0" } },
  });

  const query = keywords.length ? keywords.join(" ") : "open tenders";
  const search = await mcpRequest(
    mcpUrl,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query, maxResults: 3 } } },
    init.sessionId ?? undefined
  );
  return search.result;
}
