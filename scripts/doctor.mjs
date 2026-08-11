import { DatabaseSync } from "node:sqlite";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const checks = [];
const version = process.versions.node.split(".").map(Number);
checks.push([version[0] > 22 || (version[0] === 22 && version[1] >= 13), `Node.js ${process.versions.node}`, "需要 Node.js 22.13+"]);

try {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram'); INSERT INTO t(content) VALUES ('周五一起吃火锅');");
  const cjk3 = Number(db.prepare("SELECT count(*) n FROM t WHERE t MATCH '吃火锅'").get().n);
  const cjk2 = Number(db.prepare("SELECT count(*) n FROM t WHERE t MATCH '火锅'").get().n);
  checks.push([cjk3 === 1 && cjk2 === 0, `SQLite ${db.prepare("SELECT sqlite_version() v").get().v} / FTS5 trigram`, "FTS5 trigram 行为异常"]);
  checks.push([cjk2 === 0, "中文 1—2 字短词会进入实体/有界 LIKE 兜底", "当前 SQLite 行为与短词路由假设不符"]);
  db.close();
} catch (error) {
  checks.push([false, "SQLite / FTS5", error.message]);
}

try {
  const testDir = resolve("data/.doctor");
  await mkdir(testDir, { recursive: true });
  const probe = resolve(testDir, "write-test");
  await writeFile(probe, "ok", { mode: 0o600 });
  await access(probe, constants.R_OK | constants.W_OK);
  await rm(probe);
  checks.push([true, "data/ 可写", ""]);
} catch (error) {
  checks.push([false, "data/ 可写", error.message]);
}

try {
  await access(resolve(".env"), constants.R_OK);
  checks.push([true, ".env 已存在", ""]);
} catch {
  checks.push([false, ".env 尚未生成", "运行 npm run setup"]);
}

let failed = 0;
console.log("\n心忆 MemoryOS · 环境检查\n");
for (const [ok, label, help] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !help ? "" : ` — ${help}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed} 项需要处理。\n` : "\n全部基础检查通过。\n");
process.exitCode = failed ? 1 : 0;
