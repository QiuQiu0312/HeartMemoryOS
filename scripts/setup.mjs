import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const yes = process.argv.includes("--yes");
const skipInstall = process.argv.includes("--skip-install");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

console.log("\n心忆 MemoryOS V2 · 首次设置\n");
console.log("核心后端不需要安装第三方依赖；本地聊天页与可视化控制台需要一次 npm 安装。\n");

let mode = "local";
if (!yes) {
  const rl = createInterface({ input, output });
  const answer = (await rl.question("准备用在哪里？[1] 本地体验  [2] 已有网页/APP  [3] 正式生产评估（默认 1）：")).trim();
  mode = answer === "2" ? "existing" : answer === "3" ? "production" : "local";
  rl.close();
}

if (await exists(envPath)) {
  console.log("✓ 已有 .env，未覆盖任何配置或密钥");
} else {
  const template = await readFile(examplePath, "utf8");
  const configured = template
    .replace("replace-with-at-least-32-random-bytes", randomBytes(36).toString("base64url"))
    .replace("replace-with-another-32-byte-secret", randomBytes(36).toString("base64url"))
    .replace("MEMORYOS_DEMO=true", `MEMORYOS_DEMO=${mode === "local" ? "true" : "false"}`)
    .replace("MEMORYOS_LOCAL_COMPANION=true", `MEMORYOS_LOCAL_COMPANION=${mode === "local" ? "true" : "false"}`);
  await writeFile(envPath, configured, { flag: "wx", mode: 0o600 });
  console.log("✓ 已生成仅本机可读的 .env 与随机密钥");
}

await mkdir(join(root, "data"), { recursive: true });

if (!skipInstall && !(await exists(join(root, "apps/console/node_modules")))) {
  console.log("… 正在安装可视化控制台依赖");
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], join(root, "apps/console"));
  console.log("✓ 控制台依赖安装完成");
} else if (skipInstall) {
  console.log("• 已按参数跳过控制台依赖安装");
} else {
  console.log("✓ 控制台依赖已存在");
}

if (mode === "production") {
  console.log("\n你选择了正式生产评估。请先阅读 技术架构与部署说明.md；本地 SQLite 包不能被误当成多实例生产集群。\n");
} else if (mode === "existing") {
  console.log("\n你选择了接入已有项目。请把 第一次打开后把这个文档发给大模型.MD 和目标项目目录一起交给大模型。\n");
}

console.log("下一步：");
console.log("  npm run doctor   检查环境");
console.log("  npm run demo     不联网体验一次记忆写入、召回、纠正和删除");
console.log("  npm run launch   启动本地聊天、记忆 API 与可视化控制台");
console.log("\n本地聊天：http://127.0.0.1:3000  控制台：http://127.0.0.1:3000/console  API：http://127.0.0.1:8787\n");

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}
