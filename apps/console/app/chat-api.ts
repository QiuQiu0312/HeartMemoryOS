import { mintLocalDemoToken, requestApi } from "./live-api";

export type LocalProvider = {
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  useMain?: boolean;
  enabled?: boolean;
  dimensions?: number | null;
  temperature?: number;
  maxOutputTokens?: number;
};

export type LocalConfig = {
  schemaVersion: number;
  revision: number;
  firstRunComplete: boolean;
  persona: {
    companionName: string;
    personaTraits: string;
    relationshipStyle: string;
    voiceRules: string;
    firstGreeting: string;
    transparencyRule: string;
  };
  providers: {
    main: LocalProvider;
    background: LocalProvider;
    embedding: LocalProvider;
  };
  features: {
    memoryEnabled: boolean;
    autoExtractionEnabled: boolean;
    rollingSummaryEnabled: boolean;
    archiveEnabled: boolean;
    deepRecallEnabled: boolean;
    adaptiveProfileEnabled: boolean;
    firstGreetingEnabled: boolean;
    relationshipProactiveEnabled: boolean;
    externalEmbeddingConsent: boolean;
  };
  status: {
    configured: boolean;
    backgroundMode: string;
    retrievalMode: string;
    summaryCount: number;
    pendingCandidateCount: number;
    providerHealth: Record<string, { ok?: boolean; checkedAt?: string; latencyMs?: number; error?: string }>;
  };
};

export type ChatMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  type?: string;
  metadata?: { model?: string | null; inputTokens?: number | null; outputTokens?: number | null; tokenCost?: number | null; deepRecallTriggered?: boolean };
  pending?: boolean;
};

export type LocalSession = { apiUrl: string; token: string };

export async function connectLocal(apiUrl: string): Promise<LocalSession> {
  const result = await mintLocalDemoToken(apiUrl);
  return { apiUrl, token: result.token };
}

export function getLocalConfig(session: LocalSession) {
  return requestApi<LocalConfig>(session.apiUrl, "/local/v2/config", session.token);
}

export function patchLocalConfig(session: LocalSession, patch: unknown) {
  return requestApi<LocalConfig>(session.apiUrl, "/local/v2/config", session.token, { method: "PATCH", body: JSON.stringify(patch) });
}

export function startLocalSession(session: LocalSession) {
  return requestApi<{ items: ChatMessage[] }>(session.apiUrl, "/local/v2/session:start", session.token, { method: "POST", body: "{}" });
}

export function loadLocalMessages(session: LocalSession) {
  return requestApi<{ items: ChatMessage[] }>(session.apiUrl, "/local/v2/messages?limit=250", session.token);
}

export function sendLocalMessage(session: LocalSession, input: { content: string; clientMessageId: string; deepRecall?: boolean }) {
  return requestApi<{
    turnId: string;
    userMessageId: string;
    assistantMessage: ChatMessage;
    backgroundWorkQueued: string[];
    recall: {
      retrievalMode?: string;
      memoryCount?: number;
      summaryCount?: number;
      deepRecall?: { triggered?: boolean; items?: unknown[] };
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
  }>(session.apiUrl, "/local/v2/chat", session.token, { method: "POST", body: JSON.stringify(input) });
}

export function discoverProviderModels(session: LocalSession, input: Record<string, unknown>) {
  return requestApi<{ models: string[]; note?: string | null }>(session.apiUrl, "/local/v2/providers:discover", session.token, { method: "POST", body: JSON.stringify(input) });
}

export function testLocalProvider(session: LocalSession, input: Record<string, unknown>) {
  return requestApi<{ ok: boolean; latencyMs: number; model: string; warning: string }>(session.apiUrl, "/local/v2/providers:test", session.token, { method: "POST", body: JSON.stringify(input) });
}
