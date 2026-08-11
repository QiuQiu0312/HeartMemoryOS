import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

try { await access(resolve(".env")); }
catch { console.error("尚未找到 .env。请先运行 npm run setup。\n"); process.exit(1); }

const children = [
  spawn(process.execPath, ["--env-file=.env", "apps/api/src/server.js"], { stdio: "inherit" }),
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", "apps/console", "run", "dev"], { stdio: "inherit" }),
];

let stopping = false;
for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code !== 0) {
      stopping = true;
      for (const peer of children) if (!peer.killed) peer.kill("SIGTERM");
      process.exitCode = code ?? 1;
    }
  });
}

const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
