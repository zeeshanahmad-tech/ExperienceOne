// Client for Experience 2's "tender-report-agent" — the confirmed-profile handoff. Full contract
// is in PROFILE_API.md at the repo root. We post exactly once, at the moment a profile's status
// becomes "confirmed" — that's the exact trigger PROFILE_API.md itself names ("post again when
// the status becomes confirmed. That's the moment the client goes live"). Our ProfileDoc's fields
// already match what they want field-for-field, so nothing needs reshaping — post it as-is.

export interface SendProfileResult {
  ok: boolean;
  status: number;
  willReceiveWeeklyReports?: boolean;
  note?: string;
  body: unknown;
}

export async function sendConfirmedProfile(url: string, apiKey: string, profileDoc: Record<string, unknown>): Promise<SendProfileResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(profileDoc),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok,
    status: res.status,
    willReceiveWeeklyReports: body?.willReceiveWeeklyReports,
    note: body?.note,
    body,
  };
}
