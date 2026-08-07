// Firestore REST client for Cloudflare Workers — no Node, so no firebase-admin.
// Auth: sign a JWT with the service account's private key, exchange it for an
// OAuth2 access token, then call the Firestore REST API directly.

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const contents = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function getAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now })
  );
  const unsigned = `${header}.${claims}`;
  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Firestore auth token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

function toFirestoreValue(v: unknown): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFirestoreFields(v as Record<string, unknown>) } };
  throw new Error(`Cannot convert to Firestore value: ${JSON.stringify(v)}`);
}

function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(v: FirestoreValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFirestoreValue);
  if ("mapValue" in v) return fromFirestoreFields(v.mapValue.fields ?? {});
  return null;
}

function fromFirestoreFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = fromFirestoreValue(v);
  return obj;
}

export class FirestoreClient {
  private base: string;
  private accessToken: string | null = null;

  constructor(private sa: ServiceAccount) {
    this.base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  }

  private async auth(): Promise<string> {
    if (!this.accessToken) {
      this.accessToken = await getAccessToken(this.sa, "https://www.googleapis.com/auth/datastore");
    }
    return this.accessToken;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.auth();
    return fetch(`${this.base}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async get(path: string): Promise<Record<string, unknown> | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status} ${await res.text()}`);
    const doc = (await res.json()) as { fields?: Record<string, FirestoreValue> };
    return fromFirestoreFields(doc.fields ?? {});
  }

  /** Full overwrite of a document at a known path (creates it if missing). */
  async set(path: string, data: Record<string, unknown>): Promise<void> {
    const res = await this.request("PATCH", path, { fields: toFirestoreFields(data) });
    if (!res.ok) throw new Error(`Firestore SET ${path} failed: ${res.status} ${await res.text()}`);
  }

  /** Partial update — only the given top-level fields are touched. */
  async update(path: string, data: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(data).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    const res = await this.request("PATCH", `${path}?${mask}`, { fields: toFirestoreFields(data) });
    if (!res.ok) throw new Error(`Firestore UPDATE ${path} failed: ${res.status} ${await res.text()}`);
  }

  /** Adds a document with an auto-generated ID to a collection (used for messages/events). */
  async add(collectionPath: string, data: Record<string, unknown>): Promise<void> {
    const res = await this.request("POST", collectionPath, { fields: toFirestoreFields(data) });
    if (!res.ok) throw new Error(`Firestore ADD ${collectionPath} failed: ${res.status} ${await res.text()}`);
  }

  /** Lists every document in a top-level collection (used to scan `profiles` for anything stuck "processing"). */
  async list(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const results: Array<{ id: string; data: Record<string, unknown> }> = [];
    let pageToken: string | undefined;
    do {
      const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
      const res = await this.request("GET", `${collectionPath}${qs}`);
      if (!res.ok) throw new Error(`Firestore LIST ${collectionPath} failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as {
        documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
        nextPageToken?: string;
      };
      for (const doc of json.documents ?? []) {
        results.push({ id: doc.name.split("/").pop()!, data: fromFirestoreFields(doc.fields ?? {}) });
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return results;
  }
}
