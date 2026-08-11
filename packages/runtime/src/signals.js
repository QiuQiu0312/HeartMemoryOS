import { RuntimeInvariantError } from "./errors.js";
import { contentDigest, estimateTokens, parseJsonObject } from "./utils.js";

const EXPLICIT_MEMORY_CUE = /(?:\bremember\b|\bdon't forget\b|记住|别忘|你要记得|帮我记)/iu;

function eventProjection(event) {
  return {
    id: event.id,
    sequenceNo: event.sequenceNo,
    role: event.role,
    type: event.type,
    content: event.content,
    contentHash: event.contentHash,
    createdAt: event.createdAt,
  };
}

function coverageDigest(events) {
  return contentDigest(events.map((event) => ({
    id: event.id,
    sequenceNo: event.sequenceNo,
    role: event.role,
    contentHash: event.contentHash,
  })));
}

export class BackgroundSignalPlanner {
  constructor({
    repository,
    extractionMinUserMessages = 6,
    extractionTokenThreshold = 700,
    extractionMaxEvents = 40,
    summaryMinEvents = 24,
    summaryTokenThreshold = 1_800,
    summaryMaxEvents = 40,
    summarySafetyDistance = 4,
  }) {
    if (!repository) throw new RuntimeInvariantError("BackgroundSignalPlanner.repository is required");
    this.repository = repository;
    Object.assign(this, {
      extractionMinUserMessages,
      extractionTokenThreshold,
      extractionMaxEvents,
      summaryMinEvents,
      summaryTokenThreshold,
      summaryMaxEvents,
      summarySafetyDistance,
    });
  }

  async plan({ scope }) {
    const events = await this.repository.listEvents({ scope });
    if (!events.length) return [];
    return [
      ...(await this.#extractionJobs(scope, events)),
      ...(await this.#summaryJobs(scope, events)),
    ];
  }

  async #extractionJobs(scope, events) {
    const cursor = await this.repository.getTaskCursor(scope, "memory-extraction");
    const pending = events.filter((event) => event.sequenceNo > cursor && event.role === "user" && event.metadata?.memoryCapturedByProgram !== true);
    if (!pending.length) return [];
    const selected = pending.slice(0, this.extractionMaxEvents);
    const tokenEstimate = selected.reduce((sum, event) => sum + estimateTokens(event.content), 0);
    const explicit = selected.some((event) => EXPLICIT_MEMORY_CUE.test(event.content));
    if (!explicit && selected.length < this.extractionMinUserMessages && tokenEstimate < this.extractionTokenThreshold) {
      return [];
    }
    const digest = coverageDigest(selected);
    return [{
      type: "memory.extract_candidates",
      scope,
      payload: {
        fromSequence: cursor + 1,
        toSequence: selected.at(-1).sequenceNo,
        eventIds: selected.map((event) => event.id),
        coverageDigest: digest,
        explicit,
      },
      idempotencyKey: `memory.extract:${digest}`,
      maxAttempts: 4,
    }];
  }

  async #summaryJobs(scope, events) {
    const cursor = await this.repository.getSegmentCursor(scope);
    const eligibleEnd = Math.max(cursor, events.at(-1).sequenceNo - this.summarySafetyDistance);
    const pending = events.filter((event) => event.sequenceNo > cursor && event.sequenceNo <= eligibleEnd);
    if (!pending.length) return [];
    const selected = pending.slice(0, this.summaryMaxEvents);
    const tokenEstimate = selected.reduce((sum, event) => sum + estimateTokens(event.content), 0);
    if (selected.length < this.summaryMinEvents && tokenEstimate < this.summaryTokenThreshold) return [];
    const digest = coverageDigest(selected);
    return [{
      type: "memory.segment_summary",
      scope,
      payload: {
        segmentId: `segment_${digest.slice(0, 24)}`,
        fromSequence: selected[0].sequenceNo,
        toSequence: selected.at(-1).sequenceNo,
        eventIds: selected.map((event) => event.id),
        coverageDigest: digest,
      },
      idempotencyKey: `memory.summary:${digest}`,
      maxAttempts: 4,
    }];
  }
}

function loadAndVerifyEvents(repository, job) {
  return repository.listEvents({ scope: job.scope, eventIds: job.payload.eventIds }).then((events) => {
    if (events.length !== job.payload.eventIds.length || coverageDigest(events) !== job.payload.coverageDigest) {
      throw new RuntimeInvariantError("Background job evidence changed; refusing model output");
    }
    return events;
  });
}

function validateCandidateBatch(value, allowedIds) {
  if (value.schemaVersion !== 2 || !Array.isArray(value.candidates) || value.candidates.length > 12) {
    throw new RuntimeInvariantError("Invalid memory candidate batch");
  }
  const required = ["schemaVersion", "candidateKind", "realm", "attribution", "subjectRef", "predicateKey", "value", "canonicalText", "polarity", "modality", "temporal", "evidenceMessageIds", "sensitivity", "confidenceBand", "proposedAction"];
  const allowed = new Set([...required, "relatedExistingMemoryIds", "reason"]);
  const enums = {
    candidateKind: ["identity", "preference", "boundary", "relationship", "event", "commitment", "routine", "goal", "temporary", "communication_style"],
    realm: ["real_world", "relationship_canon", "roleplay", "fictional", "hypothetical", "quoted", "unknown"],
    polarity: ["positive", "negative"],
    modality: ["asserted", "preferred", "desired", "planned", "possible", "uncertain"],
    sensitivity: ["ordinary", "personal", "sensitive", "highly_sensitive", "prohibited"],
    confidenceBand: ["low", "medium", "high"],
    proposedAction: ["ignore", "keep_candidate", "request_confirmation", "create_temporary_claim"],
  };
  for (const candidate of value.candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RuntimeInvariantError("Candidate must be an object");
    }
    if (required.some((key) => !(key in candidate)) || Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new RuntimeInvariantError("Candidate does not match the strict contract");
    }
    for (const [key, choices] of Object.entries(enums)) {
      if (!choices.includes(candidate[key])) throw new RuntimeInvariantError(`Candidate ${key} is invalid`);
    }
    if (candidate.schemaVersion !== 2 || typeof candidate.subjectRef !== "string" || !candidate.subjectRef || candidate.subjectRef.length > 128) {
      throw new RuntimeInvariantError("Candidate identity fields are invalid");
    }
    if (typeof candidate.predicateKey !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(candidate.predicateKey)) {
      throw new RuntimeInvariantError("Candidate predicateKey is invalid");
    }
    if (typeof candidate.canonicalText !== "string" || !candidate.canonicalText || candidate.canonicalText.length > 1_200) {
      throw new RuntimeInvariantError("Candidate canonicalText is invalid");
    }
    if (!candidate.attribution || !["user", "assistant", "shared_observation", "unknown"].includes(candidate.attribution.assertedByType)) {
      throw new RuntimeInvariantError("Candidate attribution is invalid");
    }
    if (!candidate.temporal || !["timeless", "point", "interval", "recurring", "unknown"].includes(candidate.temporal.kind)) {
      throw new RuntimeInvariantError("Candidate temporal value is invalid");
    }
    if (!Array.isArray(candidate.evidenceMessageIds) || !candidate.evidenceMessageIds.length) {
      throw new RuntimeInvariantError("Candidate evidenceMessageIds are required");
    }
    if (candidate.evidenceMessageIds.length > 16 || new Set(candidate.evidenceMessageIds).size !== candidate.evidenceMessageIds.length || candidate.evidenceMessageIds.some((id) => !allowedIds.has(id))) {
      throw new RuntimeInvariantError("Candidate cited evidence outside the program-owned window");
    }
    if (candidate.sensitivity === "highly_sensitive" && candidate.proposedAction !== "request_confirmation") {
      throw new RuntimeInvariantError("Highly sensitive candidates require confirmation");
    }
    if (candidate.sensitivity === "prohibited" && (
      candidate.value !== null ||
      candidate.canonicalText !== "[REDACTED_PROHIBITED]" ||
      candidate.proposedAction !== "ignore" ||
      candidate.reason !== "prohibited_content"
    )) {
      throw new RuntimeInvariantError("Prohibited content must use the fixed redacted representation");
    }
  }
  return value;
}

function validateSummary(value, allowedIds) {
  const required = ["schemaVersion", "summary", "emotionalArc", "openThreads", "uncertainties", "sourceMessageIds"];
  if (!value || required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key))) {
    throw new RuntimeInvariantError("Summary does not match the strict contract");
  }
  if (value.schemaVersion !== 2 || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 5_000) {
    throw new RuntimeInvariantError("Invalid segment summary");
  }
  if (typeof value.emotionalArc !== "string" || value.emotionalArc.length > 1_000 || !Array.isArray(value.openThreads) || value.openThreads.length > 12 || !Array.isArray(value.uncertainties) || value.uncertainties.length > 12) {
    throw new RuntimeInvariantError("Invalid segment summary details");
  }
  const ids = value.sourceMessageIds;
  if (!Array.isArray(ids) || ids.length !== allowedIds.size || ids.some((id) => !allowedIds.has(id))) {
    throw new RuntimeInvariantError("Summary source coverage must exactly equal the fixed window");
  }
  for (const thread of value.openThreads ?? []) {
    if (!thread || typeof thread.text !== "string" || thread.text.length > 500 || !["open", "waiting_user", "waiting_assistant", "time_bound"].includes(thread.state) || !Array.isArray(thread.sourceMessageIds) || !thread.sourceMessageIds.length || thread.sourceMessageIds.some((id) => !allowedIds.has(id))) {
      throw new RuntimeInvariantError("Summary open thread cited evidence outside the fixed window");
    }
  }
  return value;
}

export function createMemoryBackgroundHandlers({
  repository,
  model,
  candidateSink = async () => {},
  summarySink = async () => {},
  locale = "zh-CN",
  clock = () => Date.now(),
}) {
  if (!repository || !model?.complete) throw new RuntimeInvariantError("repository and model.complete are required");
  return {
    "memory.extract_candidates": async ({ job }) => {
      const cursor = await repository.getTaskCursor(job.scope, "memory-extraction");
      if (cursor >= job.payload.toSequence) return { alreadyProcessed: true, coverageDigest: job.payload.coverageDigest };
      if (cursor !== job.payload.fromSequence - 1) throw new RuntimeInvariantError("Extraction window is not contiguous with program cursor");
      const events = await loadAndVerifyEvents(repository, job);
      const allowedIds = new Set(events.map((event) => event.id));
      const response = await model.complete({
        scope: job.scope,
        operation: "memory_extraction",
        maxOutputTokens: 1_800,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: "You extract conservative memory candidates. Return strict JSON only; never invent evidence ids or database cursors." },
          { role: "user", content: JSON.stringify({ schemaVersion: 2, locale, currentTime: new Date(clock()).toISOString(), allowedMessageIds: [...allowedIds], messages: events.map(eventProjection) }) },
        ],
      });
      const batch = validateCandidateBatch(parseJsonObject(response.text), allowedIds);
      await candidateSink({ scope: job.scope, job, events, batch });
      await repository.advanceTaskCursor(job.scope, "memory-extraction", job.payload.toSequence, {
        expectedFrom: job.payload.fromSequence - 1,
        now: clock(),
      });
      return { candidateCount: batch.candidates.length, coverageDigest: job.payload.coverageDigest };
    },
    "memory.segment_summary": async ({ job }) => {
      const cursor = await repository.getSegmentCursor(job.scope);
      if (cursor >= job.payload.toSequence) return { alreadyProcessed: true, coverageDigest: job.payload.coverageDigest };
      if (cursor !== job.payload.fromSequence - 1) throw new RuntimeInvariantError("Summary window is not contiguous with program cursor");
      const events = await loadAndVerifyEvents(repository, job);
      const allowedIds = new Set(events.map((event) => event.id));
      const response = await model.complete({
        scope: job.scope,
        operation: "segment_summary",
        maxOutputTokens: 1_500,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: "Compress the fixed conversation segment faithfully. Return strict JSON only. Never choose ranges or cursors." },
          { role: "user", content: JSON.stringify({ schemaVersion: 2, segmentId: job.payload.segmentId, locale, allowedMessageIds: [...allowedIds], coverageDigest: job.payload.coverageDigest, messages: events.map(eventProjection) }) },
        ],
      });
      const summary = validateSummary(parseJsonObject(response.text), allowedIds);
      await summarySink({ scope: job.scope, job, events, summary });
      await repository.advanceSegmentCursor(job.scope, job.payload.toSequence, clock());
      return { segmentId: job.payload.segmentId, coverageDigest: job.payload.coverageDigest };
    },
  };
}
