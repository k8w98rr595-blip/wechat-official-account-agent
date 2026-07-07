import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const SAAS_PLANS = Object.freeze({
  trial: Object.freeze({ id: "trial", name: "试用版", priceCents: 0, draftQuota: 3, seatLimit: 2, durationDays: 14 }),
  team: Object.freeze({ id: "team", name: "团队版", priceCents: 19_900, draftQuota: 60, seatLimit: 3, durationDays: 30 }),
  growth: Object.freeze({ id: "growth", name: "成长版", priceCents: 49_900, draftQuota: 200, seatLimit: 10, durationDays: 30 }),
});

const MEMBER_ROLES = new Set(["owner", "admin", "editor", "reviewer"]);

function nowIso() { return new Date().toISOString(); }
function addDays(value, days) { return new Date(new Date(value).getTime() + days * 86_400_000).toISOString(); }
function rowJson(value) { return value === null || value === undefined ? undefined : JSON.parse(value); }

function publicUser(row) {
  if (!row) return undefined;
  return { id: row.id, email: row.email, name: row.name, status: row.status, platformAdmin: Boolean(row.platform_admin), createdAt: row.created_at };
}

function publicOrganization(row) {
  if (!row) return undefined;
  return { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicSubscription(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    planId: row.plan_id,
    status: row.status,
    priceCents: row.price_cents,
    draftQuota: row.draft_quota,
    draftsUsed: row.drafts_used,
    draftsRemaining: Math.max(0, row.draft_quota - row.drafts_used),
    seatLimit: row.seat_limit,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

function publicOrder(row) {
  if (!row) return undefined;
  return {
    id: row.id, planId: row.plan_id, amountCents: row.amount_cents, currency: row.currency,
    provider: row.provider, status: row.status, createdAt: row.created_at, paidAt: row.paid_at,
    refundedAt: row.refunded_at,
  };
}

function publicRefund(row) {
  if (!row) return undefined;
  return {
    id: row.id, orderId: row.order_id, amountCents: row.amount_cents, reason: row.reason,
    status: row.status, createdAt: row.created_at, processedAt: row.processed_at,
  };
}

export class SaasStore {
  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close() { this.db.close(); }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (platform_admin IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','reviewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS workspaces (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','expired')),
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        draft_quota INTEGER NOT NULL CHECK (draft_quota >= 0),
        drafts_used INTEGER NOT NULL DEFAULT 0 CHECK (drafts_used >= 0),
        seat_limit INTEGER NOT NULL CHECK (seat_limit >= 1),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id),
        plan_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        currency TEXT NOT NULL DEFAULT 'CNY',
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','paid','canceled','refunded')),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        paid_at TEXT,
        refunded_at TEXT,
        UNIQUE (organization_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS orders_organization_id ON orders(organization_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        order_id TEXT NOT NULL REFERENCES orders(id),
        requested_by TEXT NOT NULL REFERENCES users(id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requested','approved','rejected')),
        created_at TEXT NOT NULL,
        processed_at TEXT,
        processed_by TEXT REFERENCES users(id),
        UNIQUE (order_id)
      );
      CREATE TABLE IF NOT EXISTS quota_reservations (
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK (status IN ('reserved','committed')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        operation TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_organization_id ON usage_events(organization_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        actor_user_id TEXT REFERENCES users(id),
        event TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_organization_id ON audit_logs(organization_id, created_at DESC);
    `);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  audit({ organizationId, actorUserId, event, targetType, targetId, detail = {} }) {
    this.db.prepare("INSERT INTO audit_logs (id, organization_id, actor_user_id, event, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), organizationId ?? null, actorUserId ?? null, event, targetType ?? null, targetId ?? null, JSON.stringify(detail), nowIso());
  }

  createAccount({ email, name, passwordHash, organizationName, organizationSlug, platformAdmin = false, emptyWorkspace }) {
    return this.transaction(() => {
      const timestamp = nowIso();
      const userId = randomUUID();
      const organizationId = randomUUID();
      this.db.prepare("INSERT INTO users (id, email, name, password_hash, platform_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(userId, email, name, passwordHash, platformAdmin ? 1 : 0, timestamp, timestamp);
      this.db.prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(organizationId, organizationName, organizationSlug, timestamp, timestamp);
      this.db.prepare("INSERT INTO memberships (organization_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
        .run(organizationId, userId, timestamp);
      const plan = SAAS_PLANS.trial;
      this.db.prepare("INSERT INTO subscriptions (id, organization_id, plan_id, status, price_cents, draft_quota, drafts_used, seat_limit, period_start, period_end, updated_at) VALUES (?, ?, ?, 'trialing', ?, ?, 0, ?, ?, ?, ?)")
        .run(randomUUID(), organizationId, plan.id, plan.priceCents, plan.draftQuota, plan.seatLimit, timestamp, addDays(timestamp, plan.durationDays), timestamp);
      this.db.prepare("INSERT INTO workspaces (organization_id, version, data_json, updated_by, updated_at) VALUES (?, 0, ?, ?, ?)")
        .run(organizationId, JSON.stringify(emptyWorkspace), userId, timestamp);
      this.audit({ organizationId, actorUserId: userId, event: "account.registered", targetType: "organization", targetId: organizationId });
      return { user: publicUser(this.getUserById(userId)), organization: publicOrganization(this.getOrganization(organizationId)), role: "owner" };
    });
  }

  getUserByEmail(email) { return this.db.prepare("SELECT * FROM users WHERE email = ?").get(email); }
  getUserById(id) { return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id); }

  updateUserName(userId, name) {
    const timestamp = nowIso();
    this.db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(name, timestamp, userId);
    this.audit({ actorUserId: userId, event: "user.profile_updated", targetType: "user", targetId: userId, detail: { fields: ["name"] } });
    return publicUser(this.getUserById(userId));
  }

  updatePasswordHash(userId, passwordHash) {
    return this.transaction(() => {
      const timestamp = nowIso();
      this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, timestamp, userId);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.audit({ actorUserId: userId, event: "user.password_changed", targetType: "user", targetId: userId });
    });
  }

  createSession(userId, tokenHash, expiresAt) {
    const timestamp = nowIso();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, userId, expiresAt, timestamp, timestamp);
    this.audit({ actorUserId: userId, event: "session.created", targetType: "user", targetId: userId });
  }

  getSession(tokenHash) {
    return this.db.prepare("SELECT s.*, u.email, u.name, u.status AS user_status, u.platform_admin, u.created_at AS user_created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").get(tokenHash, nowIso());
  }

  touchSession(tokenHash) { this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso(), tokenHash); }
  deleteSession(tokenHash) { this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash); }
  deleteExpiredSessions() { this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso()); }

  listMemberships(userId) {
    return this.db.prepare("SELECT m.role, o.* FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY o.created_at").all(userId)
      .map((row) => ({ organization: publicOrganization(row), role: row.role }));
  }

  getMembership(organizationId, userId) {
    return this.db.prepare("SELECT m.role, o.name AS organization_name, o.slug AS organization_slug FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.organization_id = ? AND m.user_id = ?").get(organizationId, userId);
  }

  getOrganization(id) { return this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(id); }

  updateOrganization(organizationId, name, actorUserId) {
    const timestamp = nowIso();
    this.db.prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?").run(name, timestamp, organizationId);
    this.audit({ organizationId, actorUserId, event: "organization.updated", targetType: "organization", targetId: organizationId, detail: { fields: ["name"] } });
    return publicOrganization(this.getOrganization(organizationId));
  }

  listMembers(organizationId) {
    return this.db.prepare("SELECT u.id, u.email, u.name, u.status, u.created_at, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.created_at").all(organizationId)
      .map((row) => ({ id: row.id, email: row.email, name: row.name, status: row.status, role: row.role, createdAt: row.created_at }));
  }

  addMember(organizationId, email, role, actorUserId) {
    if (!MEMBER_ROLES.has(role) || role === "owner") throw Object.assign(new Error("成员角色无效"), { code: "INVALID_INPUT" });
    return this.transaction(() => {
      const subscription = this.getSubscriptionRow(organizationId);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE organization_id = ?").get(organizationId).count;
      if (count >= subscription.seat_limit) throw Object.assign(new Error("当前套餐成员名额已用完"), { code: "SEAT_LIMIT" });
      const user = this.getUserByEmail(email);
      if (!user || user.status !== "active") throw Object.assign(new Error("该邮箱尚未注册有效账户"), { code: "USER_NOT_FOUND" });
      try {
        this.db.prepare("INSERT INTO memberships (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(organizationId, user.id, role, nowIso());
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("该用户已是企业成员"), { code: "CONFLICT" });
        throw error;
      }
      this.audit({ organizationId, actorUserId, event: "member.added", targetType: "user", targetId: user.id, detail: { role } });
      return { id: user.id, email: user.email, name: user.name, role };
    });
  }

  updateMemberRole(organizationId, targetUserId, role, actorUserId) {
    if (!MEMBER_ROLES.has(role) || role === "owner") throw Object.assign(new Error("成员角色无效"), { code: "INVALID_INPUT" });
    const target = this.getMembership(organizationId, targetUserId);
    if (!target) throw Object.assign(new Error("成员不存在"), { code: "NOT_FOUND" });
    if (target.role === "owner") throw Object.assign(new Error("不能修改企业所有者角色"), { code: "FORBIDDEN" });
    this.db.prepare("UPDATE memberships SET role = ? WHERE organization_id = ? AND user_id = ?").run(role, organizationId, targetUserId);
    this.audit({ organizationId, actorUserId, event: "member.role_updated", targetType: "user", targetId: targetUserId, detail: { role } });
  }

  removeMember(organizationId, targetUserId, actorUserId) {
    const target = this.getMembership(organizationId, targetUserId);
    if (!target) throw Object.assign(new Error("成员不存在"), { code: "NOT_FOUND" });
    if (target.role === "owner") throw Object.assign(new Error("不能移除企业所有者"), { code: "FORBIDDEN" });
    this.db.prepare("DELETE FROM memberships WHERE organization_id = ? AND user_id = ?").run(organizationId, targetUserId);
    this.audit({ organizationId, actorUserId, event: "member.removed", targetType: "user", targetId: targetUserId });
  }

  getWorkspace(organizationId) {
    const row = this.db.prepare("SELECT version, data_json, updated_by, updated_at FROM workspaces WHERE organization_id = ?").get(organizationId);
    if (!row) return undefined;
    return { version: row.version, data: rowJson(row.data_json), updatedBy: row.updated_by, updatedAt: row.updated_at };
  }

  saveWorkspace(organizationId, userId, expectedVersion, data) {
    return this.transaction(() => {
      const current = this.getWorkspace(organizationId);
      if (!current) throw Object.assign(new Error("云端工作区不存在"), { code: "NOT_FOUND" });
      if (current.version !== expectedVersion) throw Object.assign(new Error("云端工作区已由其他成员更新，请刷新后重试"), { code: "VERSION_CONFLICT", currentVersion: current.version });
      const version = current.version + 1;
      const timestamp = nowIso();
      this.db.prepare("UPDATE workspaces SET version = ?, data_json = ?, updated_by = ?, updated_at = ? WHERE organization_id = ?")
        .run(version, JSON.stringify(data), userId, timestamp, organizationId);
      this.audit({ organizationId, actorUserId: userId, event: "workspace.updated", targetType: "workspace", targetId: organizationId, detail: { version } });
      return { version, updatedAt: timestamp };
    });
  }

  getSubscriptionRow(organizationId) { return this.db.prepare("SELECT * FROM subscriptions WHERE organization_id = ?").get(organizationId); }
  getSubscription(organizationId) { return publicSubscription(this.getSubscriptionRow(organizationId)); }

  createOrder(organizationId, userId, planId, idempotencyKey, provider = "manual") {
    const plan = SAAS_PLANS[planId];
    if (!plan || plan.id === "trial") throw Object.assign(new Error("套餐无效"), { code: "INVALID_INPUT" });
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM orders WHERE organization_id = ? AND idempotency_key = ?").get(organizationId, idempotencyKey);
      if (existing) return publicOrder(existing);
      const id = randomUUID();
      this.db.prepare("INSERT INTO orders (id, organization_id, created_by, plan_id, amount_cents, provider, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
        .run(id, organizationId, userId, plan.id, plan.priceCents, provider, idempotencyKey, nowIso());
      this.audit({ organizationId, actorUserId: userId, event: "order.created", targetType: "order", targetId: id, detail: { planId: plan.id, amountCents: plan.priceCents } });
      return publicOrder(this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
    });
  }

  listOrders(organizationId) { return this.db.prepare("SELECT * FROM orders WHERE organization_id = ? ORDER BY created_at DESC").all(organizationId).map(publicOrder); }

  markOrderPaid(orderId, adminUserId) {
    return this.transaction(() => {
      const order = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
      if (!order) throw Object.assign(new Error("订单不存在"), { code: "NOT_FOUND" });
      if (order.status !== "pending") throw Object.assign(new Error("订单状态不允许确认支付"), { code: "INVALID_STATE" });
      const plan = SAAS_PLANS[order.plan_id];
      if (!plan || order.amount_cents !== plan.priceCents) throw Object.assign(new Error("订单价格校验失败"), { code: "INVALID_STATE" });
      const timestamp = nowIso();
      this.db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'").run(timestamp, orderId);
      this.db.prepare("UPDATE subscriptions SET plan_id = ?, status = 'active', price_cents = ?, draft_quota = ?, drafts_used = 0, seat_limit = ?, period_start = ?, period_end = ?, updated_at = ? WHERE organization_id = ?")
        .run(plan.id, plan.priceCents, plan.draftQuota, plan.seatLimit, timestamp, addDays(timestamp, plan.durationDays), timestamp, order.organization_id);
      this.audit({ organizationId: order.organization_id, actorUserId: adminUserId, event: "order.paid", targetType: "order", targetId: orderId, detail: { planId: plan.id, amountCents: plan.priceCents } });
      return publicOrder(this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId));
    });
  }

  requestRefund(organizationId, orderId, userId, reason) {
    return this.transaction(() => {
      const order = this.db.prepare("SELECT * FROM orders WHERE id = ? AND organization_id = ?").get(orderId, organizationId);
      if (!order) throw Object.assign(new Error("订单不存在"), { code: "NOT_FOUND" });
      if (order.status !== "paid") throw Object.assign(new Error("只有已支付订单可以申请退款"), { code: "INVALID_STATE" });
      const existing = this.db.prepare("SELECT * FROM refunds WHERE order_id = ?").get(orderId);
      if (existing) return publicRefund(existing);
      const id = randomUUID();
      this.db.prepare("INSERT INTO refunds (id, organization_id, order_id, requested_by, amount_cents, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)")
        .run(id, organizationId, orderId, userId, order.amount_cents, reason, nowIso());
      this.audit({ organizationId, actorUserId: userId, event: "refund.requested", targetType: "refund", targetId: id, detail: { orderId, amountCents: order.amount_cents } });
      return publicRefund(this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id));
    });
  }

  processRefund(refundId, approved, adminUserId) {
    return this.transaction(() => {
      const refund = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId);
      if (!refund) throw Object.assign(new Error("退款申请不存在"), { code: "NOT_FOUND" });
      if (refund.status !== "requested") throw Object.assign(new Error("退款状态不允许处理"), { code: "INVALID_STATE" });
      const timestamp = nowIso();
      const status = approved ? "approved" : "rejected";
      this.db.prepare("UPDATE refunds SET status = ?, processed_at = ?, processed_by = ? WHERE id = ? AND status = 'requested'").run(status, timestamp, adminUserId, refundId);
      if (approved) {
        this.db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'paid'").run(timestamp, refund.order_id);
        this.db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE organization_id = ?").run(timestamp, refund.organization_id);
      }
      this.audit({ organizationId: refund.organization_id, actorUserId: adminUserId, event: approved ? "refund.approved" : "refund.rejected", targetType: "refund", targetId: refundId, detail: { orderId: refund.order_id, amountCents: refund.amount_cents } });
      return publicRefund(this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId));
    });
  }

  reserveDraftQuota(organizationId, userId, idempotencyKey) {
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT status FROM quota_reservations WHERE organization_id = ? AND idempotency_key = ?").get(organizationId, idempotencyKey);
      if (duplicate) throw Object.assign(new Error("该生成请求已经处理"), { code: "DUPLICATE_REQUEST" });
      const subscription = this.getSubscriptionRow(organizationId);
      if (!subscription || !["trialing", "active"].includes(subscription.status) || subscription.period_end <= nowIso()) {
        throw Object.assign(new Error("订阅已到期，请续费后继续生成"), { code: "SUBSCRIPTION_REQUIRED" });
      }
      if (subscription.drafts_used >= subscription.draft_quota) throw Object.assign(new Error("本期成稿额度已用完"), { code: "QUOTA_EXCEEDED" });
      this.db.prepare("UPDATE subscriptions SET drafts_used = drafts_used + 1, updated_at = ? WHERE organization_id = ?").run(nowIso(), organizationId);
      this.db.prepare("INSERT INTO quota_reservations (organization_id, idempotency_key, user_id, status, created_at) VALUES (?, ?, ?, 'reserved', ?)").run(organizationId, idempotencyKey, userId, nowIso());
    });
  }

  commitDraftQuota(organizationId, idempotencyKey) {
    this.db.prepare("UPDATE quota_reservations SET status = 'committed' WHERE organization_id = ? AND idempotency_key = ? AND status = 'reserved'").run(organizationId, idempotencyKey);
  }

  releaseDraftQuota(organizationId, idempotencyKey) {
    return this.transaction(() => {
      const result = this.db.prepare("DELETE FROM quota_reservations WHERE organization_id = ? AND idempotency_key = ? AND status = 'reserved'").run(organizationId, idempotencyKey);
      if (result.changes) this.db.prepare("UPDATE subscriptions SET drafts_used = MAX(0, drafts_used - 1), updated_at = ? WHERE organization_id = ?").run(nowIso(), organizationId);
    });
  }

  recordUsage({ organizationId, userId, operation, model, inputTokens = 0, outputTokens = 0, costMicrousd = 0, requestId }) {
    this.db.prepare("INSERT INTO usage_events (id, organization_id, user_id, operation, model, input_tokens, output_tokens, cost_microusd, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), organizationId, userId, operation, model, inputTokens, outputTokens, costMicrousd, requestId, nowIso());
  }

  adminMetrics() {
    const totals = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM organizations) AS organizations,
      (SELECT COUNT(*) FROM subscriptions WHERE status IN ('trialing','active')) AS active_subscriptions,
      (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status = 'paid') AS revenue_cents,
      (SELECT COALESCE(SUM(input_tokens),0) FROM usage_events) AS input_tokens,
      (SELECT COALESCE(SUM(output_tokens),0) FROM usage_events) AS output_tokens,
      (SELECT COALESCE(SUM(cost_microusd),0) FROM usage_events) AS cost_microusd,
      (SELECT COUNT(*) FROM refunds WHERE status = 'requested') AS pending_refunds
    `).get();
    const organizations = this.db.prepare("SELECT o.id, o.name, o.slug, o.created_at, s.plan_id, s.status, s.draft_quota, s.drafts_used, s.period_end, (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id) AS members FROM organizations o JOIN subscriptions s ON s.organization_id = o.id ORDER BY o.created_at DESC LIMIT 100").all();
    const pendingOrders = this.db.prepare("SELECT id, organization_id, plan_id, amount_cents, provider, status, created_at FROM orders WHERE status = 'pending' ORDER BY created_at LIMIT 100").all();
    const pendingRefunds = this.db.prepare("SELECT id, organization_id, order_id, amount_cents, reason, status, created_at FROM refunds WHERE status = 'requested' ORDER BY created_at LIMIT 100").all();
    return { totals, organizations, pendingOrders, pendingRefunds };
  }
}

export function serializePlans() {
  return Object.values(SAAS_PLANS).map(({ durationDays: _durationDays, ...plan }) => plan);
}
