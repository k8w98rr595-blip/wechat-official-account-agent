import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "../backend/server.mjs";
import { SaasService } from "../backend/lib/saas-service.mjs";

const bootstrapAdminToken = "test-bootstrap-token-2026-at-least-32-characters";
const validBrief = { campaignType: "product", subject: "新品发布", audience: "企业客户", objective: "预约体验", keyMessage: "已确认卖点", proofPoints: ["已有试点材料"], cta: "预约体验", eventDetails: "不适用", restrictions: [], missingFacts: [] };
const validDirection = { id: "value-first", title: "新品发布：值得关注的价值", angle: "价值先行", outline: ["读者需求", "事实依据", "行动指令"] };

async function startSaas(t, options = {}) {
  const service = new SaasService({ bootstrapAdminEmail: "admin@example.com", bootstrapAdminToken });
  const events = [];
  const server = createServer({ saasEnabled: true, saasService: service, providerMode: "mock", securityLogger: (event) => events.push(event), ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); service.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, service, events };
}

async function request(base, path, { method = "GET", token, organizationId, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (organizationId) requestHeaders["x-organization-id"] = organizationId;
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  return { status: response.status, body: value, headers: response.headers };
}

async function register(base, email, organizationName = "示例企业") {
  const response = await request(base, "/api/saas/register", { method: "POST", body: { email, password: "strong-pass-2026", name: email.split("@")[0], organizationName, ...(email === "admin@example.com" ? { bootstrapToken: bootstrapAdminToken } : {}) } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { token: response.body.token, organizationId: response.body.organization.id, userId: response.body.user.id };
}

test("SaaS 注册、登录和会话不会暴露密码哈希", async (t) => {
  const { base, service } = await startSaas(t);
  const account = await register(base, "owner@example.com");
  assert.equal((await request(base, "/api/saas/me", { token: account.token })).status, 200);
  assert.equal((await request(base, "/api/saas/me", { token: "invalid-session-token-that-is-long-enough" })).status, 401);

  const login = await request(base, "/api/saas/login", { method: "POST", body: { email: "OWNER@example.com", password: "strong-pass-2026" } });
  assert.equal(login.status, 200);
  assert.equal(JSON.stringify(login.body).includes("password"), false);
  const updated = await request(base, "/api/saas/profile", { method: "PATCH", token: login.body.token, body: { name: "Updated Owner" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.name, "Updated Owner");
  assert.equal((await request(base, "/api/saas/profile", { method: "PATCH", token: login.body.token, body: { name: "Owner", platformAdmin: true } })).status, 400);
  assert.equal((await request(base, "/api/saas/change-password", { method: "POST", token: login.body.token, body: { currentPassword: "wrong-pass-2026", newPassword: "new-strong-pass-2026" } })).status, 401);
  const changed = await request(base, "/api/saas/change-password", { method: "POST", token: login.body.token, body: { currentPassword: "strong-pass-2026", newPassword: "new-strong-pass-2026" } });
  assert.equal(changed.status, 200);
  assert.equal((await request(base, "/api/saas/me", { token: login.body.token })).status, 401);
  assert.equal((await request(base, "/api/saas/login", { method: "POST", body: { email: "owner@example.com", password: "strong-pass-2026" } })).status, 401);
  assert.equal((await request(base, "/api/saas/login", { method: "POST", body: { email: "owner@example.com", password: "new-strong-pass-2026" } })).status, 200);
  const stored = service.store.getUserByEmail("owner@example.com");
  assert.match(stored.password_hash, /^scrypt\$/);
  assert.equal(stored.password_hash.includes("new-strong-pass-2026"), false);

  assert.equal((await request(base, "/api/saas/logout", { method: "POST", token: changed.body.token, body: {} })).status, 200);
  assert.equal((await request(base, "/api/saas/me", { token: changed.body.token })).status, 401);
});

test("平台管理员邮箱必须同时提供正确的初始化码", async (t) => {
  const { base } = await startSaas(t);
  const payload = { email: "admin@example.com", password: "strong-pass-2026", name: "平台管理员", organizationName: "平台企业" };
  assert.equal((await request(base, "/api/saas/register", { method: "POST", body: payload })).status, 403);
  assert.equal((await request(base, "/api/saas/register", { method: "POST", body: { ...payload, bootstrapToken: "wrong-bootstrap-token-that-is-long-enough" } })).status, 403);
  assert.equal((await request(base, "/api/saas/register", { method: "POST", body: { ...payload, bootstrapToken: bootstrapAdminToken } })).body.user.platformAdmin, true);
});

test("所有工作区读写强制执行企业成员关系和乐观版本锁", async (t) => {
  const { base } = await startSaas(t);
  const alpha = await register(base, "alpha@example.com", "甲企业");
  const beta = await register(base, "beta@example.com", "乙企业");

  assert.equal((await request(base, "/api/saas/workspace", { token: alpha.token, organizationId: beta.organizationId })).status, 403);
  const current = await request(base, "/api/saas/workspace", { token: alpha.token, organizationId: alpha.organizationId });
  assert.equal(current.status, 200);
  current.body.data.brand.companyName = "甲企业品牌";

  const saved = await request(base, "/api/saas/workspace", { method: "PUT", token: alpha.token, organizationId: alpha.organizationId, body: { version: current.body.version, data: current.body.data } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, 1);
  const stale = await request(base, "/api/saas/workspace", { method: "PUT", token: alpha.token, organizationId: alpha.organizationId, body: { version: 0, data: current.body.data } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 1);

  const injected = structuredClone(current.body.data);
  injected.projects.push({ id: "x\" onfocus=\"alert(1)", role: "owner" });
  assert.equal((await request(base, "/api/saas/workspace", { method: "PUT", token: alpha.token, organizationId: alpha.organizationId, body: { version: 1, data: injected } })).status, 400);
});

test("成员角色由服务端控制且审核人不能修改工作区或调用 Agent", async (t) => {
  const { base } = await startSaas(t);
  const owner = await register(base, "owner@example.com", "主企业");
  const reviewer = await register(base, "reviewer@example.com", "个人工作区");

  const added = await request(base, "/api/saas/members", { method: "POST", token: owner.token, organizationId: owner.organizationId, body: { email: "reviewer@example.com", role: "reviewer", platformAdmin: true } });
  assert.equal(added.status, 400);
  const validAdd = await request(base, "/api/saas/members", { method: "POST", token: owner.token, organizationId: owner.organizationId, body: { email: "reviewer@example.com", role: "reviewer" } });
  assert.equal(validAdd.status, 201);

  const workspace = await request(base, "/api/saas/workspace", { token: reviewer.token, organizationId: owner.organizationId });
  assert.equal(workspace.status, 200);
  assert.equal((await request(base, "/api/saas/workspace", { method: "PUT", token: reviewer.token, organizationId: owner.organizationId, body: { version: workspace.body.version, data: workspace.body.data } })).status, 403);
  const interview = await request(base, "/api/agent/interview", { method: "POST", token: reviewer.token, organizationId: owner.organizationId, body: { campaignType: "product", idea: "新品", answers: [], brand: {} } });
  assert.equal(interview.status, 403);
});

test("成稿额度按企业隔离、失败释放且幂等编号防止重复扣费", async (t) => {
  const { base } = await startSaas(t);
  const account = await register(base, "writer@example.com");
  const headers = { "x-idempotency-key": "draft-request-0000000001" };
  const body = { brief: validBrief, direction: validDirection, brand: {}, assets: [] };
  const first = await request(base, "/api/agent/draft", { method: "POST", token: account.token, organizationId: account.organizationId, headers, body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  let subscription = await request(base, "/api/saas/subscription", { token: account.token, organizationId: account.organizationId });
  assert.equal(subscription.body.subscription.draftsUsed, 1);

  const duplicate = await request(base, "/api/agent/draft", { method: "POST", token: account.token, organizationId: account.organizationId, headers, body });
  assert.equal(duplicate.status, 409);
  subscription = await request(base, "/api/saas/subscription", { token: account.token, organizationId: account.organizationId });
  assert.equal(subscription.body.subscription.draftsUsed, 1);

  const invalid = await request(base, "/api/agent/draft", { method: "POST", token: account.token, organizationId: account.organizationId, headers: { "x-idempotency-key": "draft-request-0000000002" }, body: { brief: {}, direction: {}, brand: {} } });
  assert.equal(invalid.status, 400);
  subscription = await request(base, "/api/saas/subscription", { token: account.token, organizationId: account.organizationId });
  assert.equal(subscription.body.subscription.draftsUsed, 1);
});

test("订单价格不可篡改，跨企业退款和非管理员确认支付被拒绝", async (t) => {
  const { base } = await startSaas(t);
  const admin = await register(base, "admin@example.com", "平台管理企业");
  const buyer = await register(base, "buyer@example.com", "购买企业");
  const attacker = await register(base, "attacker@example.com", "攻击企业");

  const tampered = await request(base, "/api/saas/orders", { method: "POST", token: buyer.token, organizationId: buyer.organizationId, body: { planId: "team", idempotencyKey: "order-idempotency-0001", amountCents: 1 } });
  assert.equal(tampered.status, 400);
  const created = await request(base, "/api/saas/orders", { method: "POST", token: buyer.token, organizationId: buyer.organizationId, body: { planId: "team", idempotencyKey: "order-idempotency-0001" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.amountCents, 19_900);
  const duplicate = await request(base, "/api/saas/orders", { method: "POST", token: buyer.token, organizationId: buyer.organizationId, body: { planId: "team", idempotencyKey: "order-idempotency-0001" } });
  assert.equal(duplicate.body.id, created.body.id);

  assert.equal((await request(base, `/api/saas/admin/orders/${created.body.id}/paid`, { method: "POST", token: buyer.token, body: {} })).status, 403);
  assert.equal((await request(base, `/api/saas/admin/orders/${created.body.id}/paid`, { method: "POST", token: admin.token, body: {} })).status, 200);
  const subscription = await request(base, "/api/saas/subscription", { token: buyer.token, organizationId: buyer.organizationId });
  assert.equal(subscription.body.subscription.planId, "team");
  assert.equal(subscription.body.subscription.draftQuota, 60);

  assert.equal((await request(base, `/api/saas/orders/${created.body.id}/refund`, { method: "POST", token: attacker.token, organizationId: attacker.organizationId, body: { reason: "越权退款" } })).status, 404);
  const refund = await request(base, `/api/saas/orders/${created.body.id}/refund`, { method: "POST", token: buyer.token, organizationId: buyer.organizationId, body: { reason: "不再需要服务" } });
  assert.equal(refund.status, 201);
  assert.equal((await request(base, `/api/saas/admin/refunds/${refund.body.id}/process`, { method: "POST", token: buyer.token, body: { approved: true } })).status, 403);
  assert.equal((await request(base, `/api/saas/admin/refunds/${refund.body.id}/process`, { method: "POST", token: admin.token, body: { approved: true } })).status, 200);
});

test("管理成本监控仅平台管理员可见且安全日志不含密码和会话", async (t) => {
  const { base, events } = await startSaas(t);
  const admin = await register(base, "admin@example.com");
  const user = await register(base, "user@example.com");
  assert.equal((await request(base, "/api/saas/admin/metrics", { token: user.token })).status, 403);
  const metrics = await request(base, "/api/saas/admin/metrics", { token: admin.token });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.totals.users, 2);
  assert.equal(JSON.stringify(metrics.body).includes("password_hash"), false);

  await request(base, "/api/saas/login", { method: "POST", body: { email: "user@example.com", password: "wrong-password-2026" } });
  const logs = JSON.stringify(events);
  assert.equal(logs.includes("wrong-password-2026"), false);
  assert.equal(logs.includes(user.token), false);
});
