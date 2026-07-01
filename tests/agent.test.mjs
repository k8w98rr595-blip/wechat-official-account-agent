import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { runAgentOperation, runMockOperation, sanitizeArticleHtml } from "../backend/lib/agent-core.mjs";
import { runStaticAgentOperation } from "../frontend/public/mock-agent.js";

const brand = { companyName: "示例品牌", targetAudience: "企业客户", defaultCta: "预约体验", forbiddenTerms: "绝对、第一" };

test("访谈每次只返回一个问题并在五轮后生成简报", () => {
  const payload = { campaignType: "product", idea: "宣传一款新产品", brand, answers: [] };
  const first = runMockOperation("interview", payload);
  assert.equal(first.status, "question");
  assert.equal(first.question.id, "audience");
  payload.answers = [
    { questionId: "audience", answer: "企业采购负责人" },
    { questionId: "objective", answer: "预约演示" },
    { questionId: "selling-points", answer: "部署简单；数据清晰；服务稳定" },
    { questionId: "proof", answer: "已有试点材料" },
    { questionId: "constraints", answer: "不能使用绝对化表述" },
  ];
  const result = runMockOperation("interview", payload);
  assert.equal(result.status, "brief");
  assert.equal(result.brief.audience, "企业采购负责人");
  assert.deepEqual(result.brief.missingFacts, []);
});

test("内容方向固定返回三组并可生成可编辑 HTML", () => {
  const brief = { campaignType: "event", subject: "开放日活动", audience: "附近居民", objective: "报名", keyMessage: "现场体验", proofPoints: ["产品演示"], cta: "立即报名", eventDetails: "7月10日，公司展厅", restrictions: [], missingFacts: [] };
  const { directions } = runMockOperation("directions", { brief });
  assert.equal(directions.length, 3);
  const { articleHtml } = runMockOperation("draft", { brief, direction: directions[0], brand });
  assert.match(articleHtml, /<h1>/);
  assert.match(articleHtml, /立即报名/);
});

test("Mock 方向会从长想法中提取简短活动主题", () => {
  const brief = { subject: "我们准备在7月10日下午两点举办新品体验日，地点在公司展厅。" };
  const { directions } = runMockOperation("directions", { brief });
  assert.match(directions[0].title, /^新品体验日：/);
});

test("GitHub Pages 浏览器 Agent 与服务端 Mock 生成一致", () => {
  const payload = {
    brief: { subject: "夏季新品发布", campaignType: "product" },
  };
  assert.deepEqual(
    runStaticAgentOperation("directions", payload),
    runMockOperation("directions", payload),
  );
});

test("发布检查阻止含待补充信息的文章", () => {
  const result = runMockOperation("audit", { articleText: "【待补充：活动时间】", brief: { missingFacts: ["活动时间"] } });
  assert.equal(result.issues[0].severity, "blocking");
});

test("正文清洗移除脚本、事件属性和未知标签", () => {
  const clean = sanitizeArticleHtml('<h1 onclick="bad()">标题</h1><script>alert(1)</script><iframe src="x">危险</iframe><a href="javascript:bad()">链接</a>');
  assert.equal(clean.includes("script"), false);
  assert.equal(clean.includes("onclick"), false);
  assert.equal(clean.includes("iframe"), false);
  assert.equal(clean.includes("javascript:"), false);
});

test("OpenAI-compatible 适配器调用 chat/completions 并解析结构化结果", async (t) => {
  let authorization = "";
  const provider = http.createServer(async (request, response) => {
    authorization = request.headers.authorization || "";
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ replacement: "保留事实后的自然表达" }) } }] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => provider.close());
  const { port } = provider.address();
  const result = await runAgentOperation("rewrite", { text: "原文", instruction: "更自然" }, {
    AGENT_PROVIDER_MODE: "openai-compatible",
    AGENT_BASE_URL: `http://127.0.0.1:${port}`,
    AGENT_API_KEY: "test-key",
    AGENT_MODEL: "test-model",
    AGENT_TIMEOUT_MS: "2000",
  });
  assert.equal(result.replacement, "保留事实后的自然表达");
  assert.equal(authorization, "Bearer test-key");
});
