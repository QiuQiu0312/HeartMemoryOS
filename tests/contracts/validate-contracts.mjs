#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYamlDocument } from "yaml";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contractsDir = path.join(projectRoot, "contracts");
const promptsDir = path.join(projectRoot, "prompts");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function parseJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function parseYaml(absolutePath) {
  try {
    return parseYamlDocument(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    assert.fail(`YAML parse failed for ${absolutePath}: ${error.message}`);
  }
}

function walk(value, visit, pointer = "#") {
  visit(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${pointer}/${index}`));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visit, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  }
}

function resolvePointer(document, fragment) {
  if (fragment === "#" || fragment === "") return document;
  assert.ok(fragment.startsWith("#/"), `unsupported JSON pointer: ${fragment}`);
  return fragment.slice(2).split("/").reduce((node, part) => {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(node && Object.hasOwn(node, key), `unresolved JSON pointer ${fragment}`);
    return node[key];
  }, document);
}

function validateRefs(document, sourcePath) {
  walk(document, (node, pointer) => {
    if (!node || typeof node !== "object" || typeof node.$ref !== "string") return;
    const [filePart, fragmentPart = ""] = node.$ref.split("#", 2);
    if (!filePart) {
      resolvePointer(document, `#${fragmentPart}`);
      return;
    }
    const targetPath = path.resolve(path.dirname(sourcePath), filePart);
    assert.ok(fs.existsSync(targetPath), `${sourcePath}${pointer} references missing ${targetPath}`);
    const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    if (fragmentPart) resolvePointer(target, `#${fragmentPart}`);
  });
}

function listFiles(root, excludedDirectoryNames = new Set()) {
  const output = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  visit(root);
  return output;
}

function schemaEnum(document, pointer) {
  const value = resolvePointer(document, pointer);
  assert.ok(Array.isArray(value.enum), `${pointer} has no enum`);
  return value.enum;
}

function assertBalancedSqlParentheses(sql) {
  let depth = 0;
  let line = 1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "\n") line += 1;
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      line += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length - 1 && !(sql[index] === "*" && sql[index + 1] === "/")) {
        if (sql[index] === "\n") line += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
        else if (sql[index] === "'") break;
        else { if (sql[index] === "\n") line += 1; index += 1; }
      }
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') index += 2;
        else if (sql[index] === '"') break;
        else { if (sql[index] === "\n") line += 1; index += 1; }
      }
      continue;
    }
    if (char === "$") {
      const tag = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$/)?.[0];
      if (tag) { index += tag.length - 1; continue; }
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    assert.ok(depth >= 0, `SQL has an unmatched closing parenthesis near line ${line}`);
  }
  assert.equal(depth, 0, "SQL has unmatched opening parentheses");
}

test("all JSON, YAML and references parse", () => {
  const schemaFiles = listFiles(path.join(contractsDir, "schemas")).filter((file) => file.endsWith(".json"));
  for (const file of schemaFiles) {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
    validateRefs(document, file);
  }

  const openapiPath = path.join(contractsDir, "openapi.yaml");
  const openapi = parseYaml(openapiPath);
  assert.equal(openapi.openapi, "3.1.0");
  validateRefs(openapi, openapiPath);

  const promptFiles = listFiles(promptsDir).filter((file) => file.endsWith(".yaml"));
  for (const file of promptFiles) parseYaml(file);
  parseJson("prompts/registry.seed.json");
});

test("OpenAPI operations are unique, bounded and never accept tenant/user identity", () => {
  const openapi = parseYaml(path.join(contractsDir, "openapi.yaml"));
  const operationIds = new Set();
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const writeMethods = new Set(["post", "put", "patch", "delete"]);
  for (const [route, pathItem] of Object.entries(openapi.paths)) {
    const allowedPathKeys = new Set(["$ref", "summary", "description", "get", "put", "post", "delete", "options", "head", "patch", "trace", "servers", "parameters"]);
    for (const key of Object.keys(pathItem)) assert.ok(allowedPathKeys.has(key), `${route} has invalid Path Item key ${key}`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      assert.ok(operation.operationId, `${method.toUpperCase()} ${route} lacks operationId`);
      assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${method.toUpperCase()} ${route} lacks responses`);
      assert.ok(!operationIds.has(operation.operationId), `duplicate operationId ${operation.operationId}`);
      operationIds.add(operation.operationId);
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      for (const name of route.matchAll(/\{([^}]+)\}/g)) {
        assert.ok(parameters.some((item) => {
          const parameter = item.$ref ? resolvePointer(openapi, item.$ref) : item;
          return parameter.name === name[1] && parameter.in === "path" && parameter.required === true;
        }),
        `${method.toUpperCase()} ${route} lacks path parameter ${name[1]}`);
      }
      if (writeMethods.has(method)) {
        assert.ok(parameters.some((item) => item.$ref === "#/components/parameters/IdempotencyKey" || item.name === "Idempotency-Key"),
          `${method.toUpperCase()} ${route} lacks Idempotency-Key`);
      }
    }
  }
  assert.doesNotMatch(read("contracts/openapi.yaml"), /^\s+(tenantId|userId):/m);
});

test("prompt registry resolves exact immutable prompt IDs, versions and output schemas", () => {
  const registry = parseJson("prompts/registry.seed.json");
  assert.equal(registry.authoritative, true);
  for (const entry of registry.prompts) {
    const promptPath = path.join(promptsDir, entry.file);
    assert.ok(fs.existsSync(promptPath), `missing prompt ${entry.file}`);
    const prompt = parseYaml(promptPath);
    assert.equal(prompt.prompt_id, entry.promptId);
    assert.equal(prompt.version, entry.version);
    assert.equal(prompt.model_class, entry.modelClass);
    if (entry.outputSchema?.startsWith("../")) {
      assert.ok(fs.existsSync(path.resolve(promptsDir, entry.outputSchema)), `missing output schema ${entry.outputSchema}`);
    }
    const outputProperties = prompt.output_contract?.root_schema?.properties ?? {};
    for (const forbidden of ["tenantId", "userId", "relationshipId", "conversationId", "scopeId", "cursor", "consent", "sendDecision"]) {
      assert.ok(!Object.hasOwn(outputProperties, forbidden), `${entry.promptId} lets model output program-owned ${forbidden}`);
    }
  }
});

test("realm, attribution, temporal history and proactive states stay aligned", () => {
  const context = parseJson("contracts/schemas/ContextEnvelope.schema.json");
  const candidate = parseJson("contracts/schemas/MemoryCandidate.schema.json");
  const proactive = parseJson("contracts/schemas/ProactiveEvent.schema.json");
  const openapi = parseYaml(path.join(contractsDir, "openapi.yaml"));
  const realms = ["real_world", "relationship_canon", "roleplay", "fictional", "hypothetical", "quoted", "unknown"];
  assert.deepEqual(schemaEnum(context, "#/$defs/Realm"), realms);
  assert.deepEqual(schemaEnum(candidate, "#/$defs/Realm"), realms);
  assert.deepEqual(openapi.components.schemas.Realm.enum, realms);
  assert.ok(openapi.components.schemas.MemoryView.required.includes("recordedUntil"), "MemoryView must expose system-time end");
  assert.deepEqual(proactive.properties.state.enum, ["scheduled", "paused", "completed", "cancelled", "expired", "failed"]);
  assert.deepEqual(openapi.paths["/v2/proactive/events"].get.parameters.find((item) => item.name === "state").schema.enum, proactive.properties.state.enum);
});

test("deletion, migration and model authority invariants are machine-visible", () => {
  const candidate = parseJson("contracts/schemas/MemoryCandidate.schema.json");
  const extraction = parseJson("contracts/schemas/MemoryExtractionResult.schema.json");
  const manifest = parseJson("contracts/schemas/ExportManifest.schema.json");
  assert.equal(extraction.properties.candidates.items.$ref, "./MemoryCandidate.schema.json");
  const prohibited = candidate.allOf.find((rule) => rule.if?.properties?.sensitivity?.const === "prohibited").then;
  assert.equal(prohibited.properties.canonicalText.const, "[REDACTED_PROHIBITED]");
  assert.equal(prohibited.properties.reason.const, "prohibited_content");
  assert.equal(prohibited.properties.proposedAction.const, "ignore");
  assert.ok(prohibited.required.includes("reason"));
  assert.equal(manifest.properties.tombstonesIncluded.const, true);
  assert.equal(manifest.properties.consentActivatesAtDestination.const, false);
  assert.equal(manifest.properties.includes.contains.const, "suppression_tombstones");
});

test("source provenance is self-contained and contains no external path dependency", () => {
  const provenance = parseJson("SOURCE_PROVENANCE.json");
  assert.ok(Array.isArray(provenance.sources) && provenance.sources.length > 0);
  assert.doesNotMatch(JSON.stringify(provenance), /\.\.\//u);
  for (const source of provenance.sources) {
    assert.equal(source.distributedWithV2, false);
    assert.match(source.packageJsonSha256, /^[a-f0-9]{64}$/u);
    assert.match(source.licenseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(source.license, "MIT");
  }
  assert.ok(Array.isArray(provenance.personaSources) && provenance.personaSources.length > 0);
  for (const source of provenance.personaSources) {
    assert.equal(source.distributedWithV2, false);
    assert.equal(source.sourceType, "user-authored persona reference");
    assert.match(source.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(typeof source.adaptation === "string" && source.adaptation.length > 20);
  }
});

test("PostgreSQL contract has balanced bodies and P0 state-machine guards", () => {
  const sql = read("contracts/postgresql-production.sql");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  const tags = [...sql.matchAll(/\$[a-zA-Z_][a-zA-Z0-9_]*\$/g)].map((match) => match[0]);
  const counts = new Map();
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const [tag, count] of counts) assert.equal(count % 2, 0, `unbalanced SQL dollar quote ${tag}`);
  assertBalancedSqlParentheses(sql);

  const functions = new Set([...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+cmem\.([a-zA-Z0-9_]+)/g)].map((match) => match[1]));
  for (const call of sql.matchAll(/EXECUTE FUNCTION\s+cmem\.([a-zA-Z0-9_]+)\s*\(/g)) {
    assert.ok(functions.has(call[1]), `trigger calls undefined function cmem.${call[1]}`);
  }

  for (const required of [
    "CREATE TABLE cmem.turns", "CREATE TRIGGER turns_state_before_write",
    "CREATE TABLE cmem.privacy_screening_receipts", "CREATE TABLE cmem.suppression_rules",
    "CREATE TABLE cmem.correction_events", "system_from timestamptz", "system_to timestamptz",
    "CREATE TABLE cmem.proactive_occurrences", "lease_fencing_token bigint",
    "CREATE TRIGGER outbound_messages_cancel_only_before_update",
    "CREATE TRIGGER delivery_attempts_authorization_before_write",
    "CREATE TABLE cmem.import_relationship_mappings",
  ]) assert.ok(sql.includes(required), `SQL missing invariant: ${required}`);

  const rlsBlock = sql.match(/-- User-scoped RLS[\s\S]+?END\n\$rls\$;/)?.[0] ?? "";
  for (const table of ["messages", "turns", "memory_claims", "claim_revisions", "suppression_rules", "proactive_events", "delivery_attempts", "import_jobs"]) {
    assert.match(rlsBlock, new RegExp(`'${table}'`), `${table} missing from user RLS list`);
  }
});

test("optional real PostgreSQL parser accepts the full DDL", { skip: !process.env.CMEM_TEST_DATABASE_URL }, () => {
  const result = spawnSync("psql", [process.env.CMEM_TEST_DATABASE_URL, "-X", "-v", "ON_ERROR_STOP=1", "-f", path.join(contractsDir, "postgresql-production.sql")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
