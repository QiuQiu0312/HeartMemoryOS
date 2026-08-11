import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the local companion test shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>[^<]*本地伴侣体验[^<]*<\/title>/i);
  assert.match(html, /正在唤醒心忆/);
  assert.match(html, /不会因为打开页面而调用模型/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("renders the Chinese memory operations console on its dedicated route", async () => {
  const response = await render("/console");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /记忆正在安静地工作/);
  assert.match(html, /后台查看/);
  assert.match(html, /0 Token/);
  assert.match(html, /记忆流水线/);
  assert.match(html, /主动消息与提醒/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("ships meaningful navigation and accessibility hooks", async () => {
  const response = await render("/console");
  const html = await response.text();
  for (const label of ["运行总览", "记忆中心", "关系时间线", "召回调试器", "提示词注册中心", "隐私与数据迁移", "成本与质量"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /aria-label="主导航"/);
  assert.match(html, /aria-label="连接真实记忆 API"/);
});
