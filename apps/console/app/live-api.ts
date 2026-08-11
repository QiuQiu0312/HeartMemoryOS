export type ApiMemory = {
  memoryId: string;
  memoryType: string;
  realm: string;
  attribution: string;
  epistemicBasis: string;
  text: string;
  confidenceBand: string;
  sensitivity: string;
  status: string;
  recordedAt: string | null;
  revision: number;
  sourceSummary?: string | null;
};

export type ApiConsent = {
  latestEventId: string;
  relationshipId: string;
  purpose: string;
  granted: boolean;
  revision: number;
  policyVersion: string;
  updatedAt: string;
};

export type ApiProactiveSettings = {
  relationshipId: string;
  transactionalEnabled: boolean;
  onboardingEnabled: boolean;
  relationshipEnabled: boolean;
  marketingEnabled: boolean;
  lockScreenContentMode: string;
  quietHours: { enabled: boolean; startLocal: string; endLocal: string; timezone: string };
  channels: string[];
  revision: number;
};

export type ApiProactiveEvent = {
  eventId: string;
  kind: string;
  summary: string;
  state: string;
  channel: string;
  generationMode: string;
  schedule: { dueAtUtc?: string; localDateTime?: string; timezone?: string; quietHoursPolicy?: string };
};

export type LiveSnapshot = {
  health: { status: string; version?: string };
  memories: ApiMemory[];
  consents: ApiConsent[];
  proactiveSettings: ApiProactiveSettings;
  proactiveEvents: ApiProactiveEvent[];
  loadedAt: string;
};

export type LiveConnection = {
  apiUrl: string;
  token: string;
  snapshot: LiveSnapshot;
};

export type ApiMemoryDetail = {
  current: ApiMemory;
  history: ApiMemory[];
  evidence: Array<{ evidenceId: string; excerpt: string | null; sourceAvailable: boolean; sourceKind: string; recordedAt: string | null }>;
  corrections: Array<{ correctionId: string; reason: string; createdAt: string | null }>;
};

export class ApiProblem extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiProblem";
    this.status = status;
    this.code = code;
  }
}

export function normalizeApiUrl(value: string) {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("只允许 http:// 或 https:// API 地址。");
  return url.toString().replace(/\/$/, "");
}

export async function requestApi<T>(apiUrl: string, path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${normalizeApiUrl(apiUrl)}${path}`, { ...init, headers, cache: "no-store" });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
    const detail = body && typeof body.detail === "string" ? body.detail : `API 返回 ${response.status}`;
    throw new ApiProblem(response.status, code, detail);
  }
  return body as T;
}

export async function loadLiveSnapshot(apiUrl: string, token: string): Promise<LiveSnapshot> {
  if (!token.trim()) throw new Error("请填入短时访问令牌。");
  const [health, memoryPage, consentPage, proactiveSettings, proactivePage] = await Promise.all([
    requestApi<{ status: string; version?: string }>(apiUrl, "/health/ready"),
    requestApi<{ items: ApiMemory[] }>(apiUrl, "/v2/memories?limit=100", token),
    requestApi<{ items: ApiConsent[] }>(apiUrl, "/v2/consents", token),
    requestApi<ApiProactiveSettings>(apiUrl, "/v2/settings/proactive", token),
    requestApi<{ items: ApiProactiveEvent[] }>(apiUrl, "/v2/proactive/events?limit=100", token),
  ]);
  return {
    health,
    memories: memoryPage.items ?? [],
    consents: consentPage.items ?? [],
    proactiveSettings,
    proactiveEvents: proactivePage.items ?? [],
    loadedAt: new Date().toISOString(),
  };
}

export async function mintLocalDemoToken(apiUrl: string) {
  return requestApi<{ token: string }>(apiUrl, "/v2/auth/demo-token", undefined, {
    method: "POST",
    body: JSON.stringify({
      tenantId: "demo_studio",
      userId: "user_lime",
      relationshipId: "relationship_lime_island",
      companionId: "companion_island",
      conversationId: "conversation_lime_island",
      roles: ["end_user", "memory_admin"],
      ttlSeconds: 3600,
    }),
  });
}
