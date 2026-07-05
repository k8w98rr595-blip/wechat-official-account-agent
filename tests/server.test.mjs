import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "../backend/server.mjs";

test("服务健康检查、静态入口和 Mock Agent API 可用", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.providerMode, "mock");

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /公众号写作 Agent/);
  assert.match(pageHtml, /src="\.\/app\.js"/);

  const staticAgent = await fetch(`${base}/mock-agent.js`);
  assert.equal(staticAgent.status, 200);
  assert.match(await staticAgent.text(), /runStaticAgentOperation/);

  const browserAgentCore = await fetch(`${base}/agent-core.js`);
  assert.equal(browserAgentCore.status, 200);
  assert.match(await browserAgentCore.text(), /runAgentOperation/);

  const interview = await fetch(`${base}/api/agent/interview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignType: "product", idea: "新品宣传", answers: [], brand: {} }) });
  assert.equal(interview.status, 200);
  assert.equal((await interview.json()).status, "question");

  const sameOriginInterview = await fetch(`${base}/api/agent/interview`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ campaignType: "product", idea: "新品宣传", answers: [], brand: {} }) });
  assert.equal(sameOriginInterview.status, 200);
});

test("Agent API 对同一来源执行速率限制", async (t) => {
  const server = createServer({ rateLimitMax: 1 }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/agent/interview`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignType: "product", idea: "新品宣传", answers: [], brand: {} }),
  };

  assert.equal((await fetch(url, init)).status, 200);
  const limited = await fetch(url, init);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /请求过于频繁/);
});

test("公开真实 AI API 拒绝未授权和非白名单来源", async (t) => {
  const allowedOrigin = "https://k8w98rr595-blip.github.io";
  const server = createServer({
    providerMode: "openai-compatible",
    accessToken: "personal-access-code",
    allowedOrigins: allowedOrigin,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/agent/interview`;

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), allowedOrigin);

  const forbiddenOrigin = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: "{}",
  });
  assert.equal(forbiddenOrigin.status, 403);

  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: { origin: allowedOrigin, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /authorization/);
});

test("真实 AI 模式没有访问保护时拒绝服务", async (t) => {
  const server = createServer({ providerMode: "openai-compatible" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/interview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 503);
});
