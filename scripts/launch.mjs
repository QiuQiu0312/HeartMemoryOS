import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiUrl = "http://127.0.0.1:8787";
const chatUrl = "http://127.0.0.1:3000";
const children = [];

console.log("\n心忆 · 本地伴侣与记忆架构体验\n");

if (!supportedNode()) {
  console.error(`当前 Node.js 是 ${process.versions.node}，需要 22.13 或更高版本。`);
  console.error("请安装当前 LTS 版本后重新双击启动文件：https://nodejs.org/\n");
  process.exit(1);
}

if (
  !(await exists(join(root, ".env")))
  || !(await exists(join(root, "node_modules/yaml/package.json")))
  || !(await exists(join(root, "apps/console/node_modules")))
) {
  console.log("检测到首次运行，正在生成本机配置并安装界面依赖…\n");
  await run(process.execPath, ["scripts/setup.mjs", "--yes"], root);
}

const apiAlreadyRunning = await probe(`${apiUrl}/health/ready`);
const consoleAlreadyRunning = await probe(chatUrl);

if (!apiAlreadyRunning) {
  children.push(spawn(process.execPath, ["--env-file=.env", "apps/api/src/server.js"], { cwd: root, stdio: "inherit" }));
} else console.log("✓ 已发现运行中的本地 API，直接复用");

if (!consoleAlreadyRunning) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  children.push(spawn(npm, ["--prefix", "apps/console", "run", "dev"], { cwd: root, stdio: "inherit" }));
} else console.log("✓ 已发现运行中的本地聊天页，直接复用");

try {
  await waitUntilReady(`${apiUrl}/health/ready`, 45_000, "记忆 API");
  await waitUntilReady(chatUrl, 90_000, "聊天页面");
  console.log(`\n✓ 已准备好：${chatUrl}`);
  console.log("浏览记忆后台：http://127.0.0.1:3000/console");
  console.log("关闭这个窗口会停止由本次启动的本地服务。\n");
  openBrowser(chatUrl);
} catch (error) {
  console.error(`\n启动未完成：${error.message}`);
  stop();
  process.exit(1);
}

if (!children.length) process.exit(0);

let stopping = false;
for (const child of children) {
  child.once("error", (error) => {
    if (!stopping) console.error(`子进程启动失败：${error.message}`);
    stop();
  });
  child.once("exit", (code) => {
    if (!stopping && code !== 0) {
      console.error(`本地服务意外退出（代码 ${code ?? "unknown"}）。`);
      stop();
    }
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function supportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

async function probe(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1_200) })).ok; }
  catch { return false; }
}

async function waitUntilReady(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  }
  throw new Error(`${label} 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有就绪`);
}

function openBrowser(url) {
  if (process.env.MEMORYOS_NO_OPEN === "true") return;
  const options = { cwd: root, detached: true, stdio: "ignore" };
  const child = process.platform === "darwin"
    ? spawn("open", [url], options)
    : process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], options)
      : spawn("xdg-open", [url], options);
  child.unref();
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(), 250).unref();
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
