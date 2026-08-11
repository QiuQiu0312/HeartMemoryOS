import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApiServer } from "./http.js";
import { FileRuntimeRepository } from "../../../packages/runtime/src/index.js";

const demoMode = process.env.MEMORYOS_DEMO === "true";
const localCompanionMode = process.env.MEMORYOS_LOCAL_COMPANION === "true";
const host = process.env.MEMORYOS_HOST ?? "127.0.0.1";
const port = integerEnv("MEMORYOS_PORT", 8787);
const dbPath = resolve(process.env.MEMORYOS_DB_PATH ?? "./data/heartmemory.sqlite");
const runtimePath = resolve(process.env.MEMORYOS_RUNTIME_PATH ?? "./data/runtime-state.json");
const generatedSecret = randomBytes(32).toString("base64url");
const authSecret = process.env.MEMORYOS_AUTH_SECRET ?? (demoMode ? generatedSecret : null);
const generatedFingerprintKey = randomBytes(32).toString("base64url");
const fingerprintKey = process.env.MEMORYOS_FINGERPRINT_KEY ?? (demoMode ? generatedFingerprintKey : null);
const localConfigPath = resolve(process.env.MEMORYOS_LOCAL_CONFIG_PATH ?? "./data/local-companion.json");
const localSecretsPath = resolve(process.env.MEMORYOS_LOCAL_SECRETS_PATH ?? "./data/local-secrets.json");
const localStatePath = resolve(process.env.MEMORYOS_LOCAL_STATE_PATH ?? "./data/local-companion-state.json");
const allowLocalProxy = process.env.MEMORYOS_LOCAL_ALLOW_PROXY === "true";

if (localCompanionMode && !isLoopbackHost(host) && !allowLocalProxy) {
  console.error("Local companion mode may only bind to loopback. Use MEMORYOS_LOCAL_ALLOW_PROXY=true only behind your own authenticated gateway.");
  process.exitCode = 1;
} else if (!authSecret || !fingerprintKey) {
  console.error("MEMORYOS_AUTH_SECRET and MEMORYOS_FINGERPRINT_KEY are required outside demo mode (at least 32 bytes each).");
  process.exitCode = 1;
} else {
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(dirname(runtimePath), { recursive: true });
  const runtimeRepository = await FileRuntimeRepository.open(runtimePath);
  const server = createApiServer({
    dbPath,
    runtimeRepository,
    authSecret,
    fingerprintKey,
    demoMode,
    allowDemoProxy: demoMode && process.env.MEMORYOS_DEMO_ALLOW_PROXY === "true",
    localCompanionMode,
    allowLocalProxy,
    localCompanionPaths: { configPath: localConfigPath, secretsPath: localSecretsPath, statePath: localStatePath },
    allowedOrigin: process.env.MEMORYOS_ALLOWED_ORIGIN ?? null,
  });
  server.listen(port, host, () => {
    console.log(`HeartMemory API listening on http://${host}:${port}`);
    console.log(`Database: ${dbPath}`);
    console.log(`Runtime state: ${runtimePath}`);
    if (demoMode) console.log("Demo token minting is enabled on loopback. Do not expose this mode to a network.");
    if (localCompanionMode) console.log("Local companion chat is enabled. Provider keys stay in the local server data directory.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isLoopbackHost(value) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(value).toLowerCase());
}

function integerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return parsed;
}
