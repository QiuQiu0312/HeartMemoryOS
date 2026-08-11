import {
  createContextEnvelope,
  createMemoryRepository,
  createTrustedAuthContext,
} from "../packages/memory-core/src/index.js";

const memory = createMemoryRepository({ fingerprintKey: "local-demo-fingerprint-key-is-not-production" });
const auth = createTrustedAuthContext({
  tenantId: "demo_studio",
  userId: "user_lime",
  relationshipId: "relationship_lime_island",
  companionId: "companion_island",
  actorId: "user_lime",
  roles: ["end_user"],
});

try {
  memory.recordConsent(auth, { category: "memory", granted: true, policyVersion: "demo-v1" });
  memory.recordConsent(auth, { purpose: "semantic_index", granted: true, policyVersion: "demo-v1" });
  const source = memory.appendMessage(auth, { role: "user", content: "记住哦，我更喜欢你回复短一点，像平时聊天那样。" });
  const saved = memory.remember(auth, {
    content: "用户更喜欢简短、自然、像日常聊天一样的回复。",
    kind: "communication_preference",
    aliases: ["回复短一点", "简短回复", "日常聊天"],
    sourceMessageId: source.messageId,
  });
  const recalled = memory.recall(auth, { query: "简短回复", trace: true });
  const envelope = createContextEnvelope({ memories: recalled.items, maxTokens: 160, perMemoryTokens: 90 });

  console.log("\n1. 已保存带证据的显式记忆");
  console.log(`   claim: ${saved.claimId}`);
  console.log("\n2. 普通召回由程序完成（没有生成式模型调用）");
  console.log(`   策略: ${recalled.strategies.join(" + ") || "无结果"}`);
  console.log(`   命中: ${recalled.items.map((item) => item.content).join("；")}`);
  console.log("\n3. 编译给主模型的有界上下文");
  console.log(`   ${envelope.usedTokens}/${envelope.maxTokens} tokens（保守估算）`);
  console.log(envelope.text);

  const corrected = memory.correct(auth, { claimId: saved.claimId, content: "用户通常喜欢简短回复，但讨论重要决定时接受稍详细的分析。", aliases: ["简短回复", "重要决定"] });
  console.log("\n4. 纠正创建新版本，旧版本不再普通召回");
  console.log(`   replacement: ${corrected.claimId}`);

  const forgotten = memory.forget(auth, { claimId: corrected.claimId });
  const afterDelete = memory.recall(auth, { query: "简短回复" });
  console.log("\n5. 删除立即隐藏，并创建防重新学习规则");
  console.log(`   deletion epoch: ${forgotten.deletionEpoch}; 删除后命中 ${afterDelete.items.length} 条`);
  console.log("\n演示完成。以上全部在内存 SQLite 中运行，没有联网，也没有消耗模型 Token。\n");
} finally {
  memory.close();
}
