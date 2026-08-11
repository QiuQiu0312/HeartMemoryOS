import { spawn } from "node:child_process";

const suites = [
  ["Memory Core", "npm", ["--prefix", "packages/memory-core", "test"]],
  ["Runtime", "npm", ["--prefix", "packages/runtime", "test"]],
  ["HTTP API", "npm", ["--prefix", "apps/api", "test"]],
  ["JavaScript client", "npm", ["--prefix", "packages/client-js", "test"]],
  ["Contracts", "node", ["--test", "tests/contracts/validate-contracts.mjs"]],
  ["Console lint", "npm", ["--prefix", "apps/console", "run", "lint"]],
  ["Console build", "npm", ["--prefix", "apps/console", "run", "build"]],
  ["Console SSR", "npm", ["--prefix", "apps/console", "test"]],
];

for (const [label, command, args] of suites) {
  console.log(`\n━━ ${label} ━━`);
  const code = await run(command, args);
  if (code !== 0) {
    console.error(`\n${label} failed with exit code ${code}.`);
    process.exit(code || 1);
  }
}
console.log("\n✓ 所有自动化测试、Lint 与构建均通过。\n");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}
