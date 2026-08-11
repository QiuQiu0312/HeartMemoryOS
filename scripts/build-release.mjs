import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const artifactRoot = resolve(projectRoot, "release-output");
const releaseName = `HeartMemoryOS-${packageJson.version}-portable`;
const releaseRoot = resolve(artifactRoot, releaseName);
const releaseProject = resolve(releaseRoot, "HeartMemoryOS");
const outerLetter = await firstExisting([
  resolve(projectRoot, "给用户的一封信.MD"),
  resolve(projectRoot, "..", "给用户的一封信.MD"),
]);
const aiGuide = resolve(projectRoot, "第一次打开后把这个文档发给大模型.MD");

const excludedDirectoryNames = new Set([
  ".git",
  ".github",
  ".next",
  ".playwright-cli",
  ".wrangler",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "release-output",
]);
const excludedRootFiles = new Set([
  ".DS_Store",
  ".env",
  "启动心忆-Windows.bat",
  "启动心忆.command",
  "第一次打开后把这个文档发给大模型.MD",
  "给用户的一封信.MD",
]);

if (!releaseRoot.startsWith(`${artifactRoot}${sep}`)) throw new Error("Refusing to build outside release-output");
await mkdir(artifactRoot, { recursive: true });
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });

await mkdir(releaseProject, { recursive: true });
for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
  if (excludedDirectoryNames.has(entry.name) || excludedRootFiles.has(entry.name) || entry.name === ".DS_Store") continue;
  await cp(resolve(projectRoot, entry.name), resolve(releaseProject, entry.name), {
    recursive: true,
    preserveTimestamps: true,
    filter(source) {
      const path = relative(projectRoot, source);
      const segments = path.split(sep);
      if (segments.some((segment) => excludedDirectoryNames.has(segment))) return false;
      if (segments.includes(".DS_Store")) return false;
      return true;
    },
  });
}

await Promise.all([
  cp(outerLetter, resolve(releaseRoot, "给用户的一封信.MD")),
  cp(aiGuide, resolve(releaseRoot, "第一次打开后把这个文档发给大模型.MD")),
]);

const macLauncher = `#!/bin/zsh

SCRIPT_DIR="\${0:A:h}"
cd "$SCRIPT_DIR/HeartMemoryOS" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js。心忆需要 Node.js 22.13 或更高版本。"
  echo "正在打开官方下载页；安装当前 LTS 版本后，再双击本文件。"
  open "https://nodejs.org/zh-cn/download" >/dev/null 2>&1
  echo ""
  read "?按回车键关闭…"
  exit 1
fi

exec node scripts/launch.mjs
`;

const windowsLauncher = `@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0HeartMemoryOS"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js，正在打开安装引导……
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\\scripts\\windows-bootstrap.ps1"
)

where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\\nodejs\\node.exe" set "PATH=%ProgramFiles%\\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 仍不可用。请安装当前 LTS 版本并重新双击本文件。
  pause
  exit /b 1
)

node scripts\\launch.mjs
if errorlevel 1 pause
endlocal
`;

await Promise.all([
  writeFile(resolve(releaseRoot, "启动心忆.command"), macLauncher, { encoding: "utf8", mode: 0o755 }),
  writeFile(resolve(releaseRoot, "启动心忆-Windows.bat"), windowsLauncher, "utf8"),
]);

console.log(`发布包已生成：${releaseRoot}`);
console.log("已排除：API 密钥、.env、真实 data、依赖目录、构建缓存、内部 Git 和私人视频稿。");

const zipPath = resolve(artifactRoot, `${releaseName}.zip`);
await rm(zipPath, { force: true });
const archiveCreated = await createZip(releaseRoot, zipPath, releaseName);
console.log(archiveCreated ? `ZIP 已生成：${zipPath}` : "当前系统没有可用的 ZIP 工具；发布文件夹已经可以直接使用。");

async function createZip(source, destination, name) {
  if (process.platform === "darwin") {
    return runArchive("ditto", [
      "-c",
      "-k",
      "--keepParent",
      "--norsrc",
      "--noextattr",
      "--noqtn",
      "--noacl",
      source,
      destination,
    ], artifactRoot);
  }
  if (process.platform === "win32") {
    const from = source.replaceAll("'", "''");
    const to = destination.replaceAll("'", "''");
    return runArchive("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Compress-Archive -LiteralPath '${from}' -DestinationPath '${to}' -Force`], artifactRoot);
  }
  return runArchive("zip", ["-qr", destination, name], artifactRoot);
}

function runArchive(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0));
  });
}

async function firstExisting(paths) {
  for (const path of paths) {
    try { await access(path); return path; } catch {}
  }
  throw new Error("缺少 给用户的一封信.MD");
}
