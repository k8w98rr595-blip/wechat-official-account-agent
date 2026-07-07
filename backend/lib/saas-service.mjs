import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { normalizeWorkspaceBackup, createEmptyWorkspace } from "../../frontend/public/workspace-schema.js";
import { SaasStore, serializePlans } from "./saas-store.mjs";

const scrypt = promisify(scryptCallback);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["owner", "admin", "editor", "reviewer"]);

export function saasError(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw saasError("INVALID_INPUT", `${label}格式无效`);
  return value;
}

function allowed(value, keys, label) {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length) throw saasError("INVALID_INPUT", `${label}包含不允许的字段`);
}

function text(value, label, { min = 0, max }) {
  if (typeof value !== "string") throw saasError("INVALID_INPUT", `${label}格式无效`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw saasError("INVALID_INPUT", `${label}长度无效`);
  return normalized;
}

function email(value) {
  const normalized = text(value, "邮箱", { min: 5, max: 254 }).toLowerCase();
  if (!EMAIL.test(normalized)) throw saasError("INVALID_INPUT", "邮箱格式无效");
  return normalized;
}

function password(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) throw saasError("INVALID_INPUT", "密码必须为10至128个字符");
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) throw saasError("INVALID_INPUT", "密码必须同时包含字母和数字");
  return value;
}

function tokenHash(token) { return createHash("sha256").update(token).digest("hex"); }

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length >= 32 && timingSafeEqual(leftBuffer, rightBuffer);
}

async function hashPassword(value) {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
}

async function verifyPassword(value, encoded) {
  const parts = String(encoded).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltValue, hashValue] = parts;
  const expected = Buffer.from(hashValue, "base64");
  const actual = Buffer.from(await scrypt(value, Buffer.from(saltValue, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 32 * 1024 * 1024 }));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicSessionUser(row) {
  return { id: row.user_id, email: row.email, name: row.name, status: row.user_status, platformAdmin: Boolean(row.platform_admin), createdAt: row.user_created_at };
}

function organizationSlug(name) {
  const stem = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
  return `${stem}-${randomBytes(4).toString("hex")}`;
}

function requireRole(context, roles) {
  if (!roles.includes(context.role)) throw saasError("FORBIDDEN", "没有执行此操作的权限", 403);
}

export class SaasService {
  constructor({ store, databasePath = ":memory:", sessionDays = 30, bootstrapAdminEmail = "", bootstrapAdminToken = "" } = {}) {
    this.store = store ?? new SaasStore(databasePath);
    this.sessionDays = Math.max(1, Math.min(Number(sessionDays) || 30, 90));
    this.bootstrapAdminEmail = String(bootstrapAdminEmail || "").trim().toLowerCase();
    this.bootstrapAdminToken = String(bootstrapAdminToken || "");
  }

  close() { this.store.close(); }
  plans() { return serializePlans(); }

  async issueSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.sessionDays * 86_400_000).toISOString();
    this.store.createSession(userId, tokenHash(token), expiresAt);
    return { token, expiresAt };
  }

  async register(payload) {
    const value = object(payload, "注册信息");
    allowed(value, ["email", "password", "name", "organizationName", "bootstrapToken"], "注册信息");
    const normalizedEmail = email(value.email);
    const normalizedPassword = password(value.password);
    const name = text(value.name, "姓名", { min: 2, max: 60 });
    const organizationName = text(value.organizationName, "企业名称", { min: 2, max: 80 });
    const passwordHash = await hashPassword(normalizedPassword);
    const bootstrapEmailMatch = Boolean(this.bootstrapAdminEmail) && normalizedEmail === this.bootstrapAdminEmail;
    const bootstrapTokenProvided = Boolean(value.bootstrapToken);
    const platformAdmin = bootstrapEmailMatch && secretsEqual(value.bootstrapToken, this.bootstrapAdminToken);
    if ((bootstrapEmailMatch || bootstrapTokenProvided) && !platformAdmin) throw saasError("INVALID_BOOTSTRAP", "管理员初始化信息无效", 403);
    let account;
    try {
      account = this.store.createAccount({
        email: normalizedEmail,
        name,
        passwordHash,
        organizationName,
        organizationSlug: organizationSlug(organizationName),
        platformAdmin,
        emptyWorkspace: createEmptyWorkspace(),
      });
    } catch (error) {
      if (String(error.message).includes("users.email")) throw saasError("CONFLICT", "该邮箱已注册", 409);
      throw error;
    }
    const session = await this.issueSession(account.user.id);
    return { ...account, organizations: this.store.listMemberships(account.user.id), subscription: this.store.getSubscription(account.organization.id), ...session };
  }

  async login(payload) {
    const value = object(payload, "登录信息");
    allowed(value, ["email", "password"], "登录信息");
    const normalizedEmail = email(value.email);
    const normalizedPassword = typeof value.password === "string" ? value.password : "";
    const user = this.store.getUserByEmail(normalizedEmail);
    const valid = user && user.status === "active" && await verifyPassword(normalizedPassword, user.password_hash);
    if (!valid) throw saasError("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
    const session = await this.issueSession(user.id);
    const organizations = this.store.listMemberships(user.id);
    return { user: { id: user.id, email: user.email, name: user.name, status: user.status, platformAdmin: Boolean(user.platform_admin), createdAt: user.created_at }, organizations, ...session };
  }

  authenticate(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length < 32 || rawToken.length > 128) throw saasError("UNAUTHENTICATED", "请先登录", 401);
    const hash = tokenHash(rawToken);
    const session = this.store.getSession(hash);
    if (!session || session.user_status !== "active") throw saasError("UNAUTHENTICATED", "登录已失效，请重新登录", 401);
    this.store.touchSession(hash);
    return { tokenHash: hash, user: publicSessionUser(session) };
  }

  logout(rawToken) {
    if (rawToken) this.store.deleteSession(tokenHash(rawToken));
  }

  context(rawToken, organizationId) {
    const auth = this.authenticate(rawToken);
    const selectedOrganizationId = text(organizationId, "企业编号", { min: 1, max: 80 });
    const membership = this.store.getMembership(selectedOrganizationId, auth.user.id);
    if (!membership) throw saasError("FORBIDDEN", "无权访问该企业", 403);
    return { ...auth, organizationId: selectedOrganizationId, role: membership.role };
  }

  me(rawToken) {
    const auth = this.authenticate(rawToken);
    const organizations = this.store.listMemberships(auth.user.id);
    return { user: auth.user, organizations };
  }

  updateProfile(rawToken, payload) {
    const auth = this.authenticate(rawToken);
    const value = object(payload, "profile");
    allowed(value, ["name"], "profile");
    return { user: this.store.updateUserName(auth.user.id, text(value.name, "name", { min: 2, max: 60 })) };
  }

  async changePassword(rawToken, payload) {
    const auth = this.authenticate(rawToken);
    const value = object(payload, "password change");
    allowed(value, ["currentPassword", "newPassword"], "password change");
    const currentPassword = typeof value.currentPassword === "string" ? value.currentPassword : "";
    const newPassword = password(value.newPassword);
    const user = this.store.getUserById(auth.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) throw saasError("INVALID_CREDENTIALS", "当前密码错误", 401);
    if (currentPassword === newPassword) throw saasError("INVALID_INPUT", "新密码不能与当前密码相同");
    this.store.updatePasswordHash(auth.user.id, await hashPassword(newPassword));
    return this.issueSession(auth.user.id);
  }

  organization(rawToken, organizationId) {
    const context = this.context(rawToken, organizationId);
    const organization = this.store.getOrganization(context.organizationId);
    return { organization: { id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.created_at, updatedAt: organization.updated_at }, role: context.role, subscription: this.store.getSubscription(context.organizationId) };
  }

  updateOrganization(rawToken, organizationId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    const value = object(payload, "企业信息");
    allowed(value, ["name"], "企业信息");
    return this.store.updateOrganization(context.organizationId, text(value.name, "企业名称", { min: 2, max: 80 }), context.user.id);
  }

  members(rawToken, organizationId) {
    const context = this.context(rawToken, organizationId);
    return { members: this.store.listMembers(context.organizationId) };
  }

  addMember(rawToken, organizationId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    const value = object(payload, "成员信息");
    allowed(value, ["email", "role"], "成员信息");
    const role = text(value.role, "成员角色", { min: 1, max: 20 });
    if (!ROLES.has(role) || role === "owner") throw saasError("INVALID_INPUT", "成员角色无效");
    return this.store.addMember(context.organizationId, email(value.email), role, context.user.id);
  }

  updateMember(rawToken, organizationId, targetUserId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    if (context.user.id === targetUserId) throw saasError("FORBIDDEN", "不能修改自己的角色", 403);
    const value = object(payload, "成员信息");
    allowed(value, ["role"], "成员信息");
    const role = text(value.role, "成员角色", { min: 1, max: 20 });
    this.store.updateMemberRole(context.organizationId, targetUserId, role, context.user.id);
    return { ok: true };
  }

  removeMember(rawToken, organizationId, targetUserId) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    if (context.user.id === targetUserId) throw saasError("FORBIDDEN", "不能移除自己", 403);
    this.store.removeMember(context.organizationId, targetUserId, context.user.id);
    return { ok: true };
  }

  getWorkspace(rawToken, organizationId) {
    const context = this.context(rawToken, organizationId);
    return this.store.getWorkspace(context.organizationId);
  }

  saveWorkspace(rawToken, organizationId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin", "editor"]);
    const value = object(payload, "云端工作区");
    allowed(value, ["version", "data"], "云端工作区");
    if (!Number.isSafeInteger(value.version) || value.version < 0) throw saasError("INVALID_INPUT", "工作区版本无效");
    let normalized;
    try { normalized = normalizeWorkspaceBackup(value.data); }
    catch (error) { throw saasError("INVALID_INPUT", error instanceof Error ? error.message : "工作区格式无效"); }
    try { return this.store.saveWorkspace(context.organizationId, context.user.id, value.version, normalized); }
    catch (error) {
      if (error.code === "VERSION_CONFLICT") throw saasError(error.code, error.message, 409, { currentVersion: error.currentVersion });
      throw error;
    }
  }

  subscription(rawToken, organizationId) {
    const context = this.context(rawToken, organizationId);
    return { subscription: this.store.getSubscription(context.organizationId), plans: this.plans() };
  }

  createOrder(rawToken, organizationId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    const value = object(payload, "订单");
    allowed(value, ["planId", "idempotencyKey"], "订单");
    return this.store.createOrder(context.organizationId, context.user.id, text(value.planId, "套餐", { min: 1, max: 30 }), text(value.idempotencyKey, "幂等编号", { min: 16, max: 100 }));
  }

  orders(rawToken, organizationId) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    return { orders: this.store.listOrders(context.organizationId) };
  }

  requestRefund(rawToken, organizationId, orderId, payload) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin"]);
    const value = object(payload, "退款申请");
    allowed(value, ["reason"], "退款申请");
    return this.store.requestRefund(context.organizationId, orderId, context.user.id, text(value.reason, "退款原因", { min: 2, max: 500 }));
  }

  reserveAgentOperation(rawToken, organizationId, operation, idempotencyKey) {
    const context = this.context(rawToken, organizationId);
    requireRole(context, ["owner", "admin", "editor"]);
    if (operation === "draft") {
      const key = text(idempotencyKey, "幂等编号", { min: 16, max: 100 });
      this.store.reserveDraftQuota(context.organizationId, context.user.id, key);
    }
    return context;
  }

  commitAgentOperation(context, operation, idempotencyKey) {
    if (operation === "draft") this.store.commitDraftQuota(context.organizationId, idempotencyKey);
  }

  releaseAgentOperation(context, operation, idempotencyKey) {
    if (operation === "draft") this.store.releaseDraftQuota(context.organizationId, idempotencyKey);
  }

  recordUsage(context, usage) { this.store.recordUsage({ organizationId: context.organizationId, userId: context.user.id, ...usage }); }

  adminMetrics(rawToken) {
    const auth = this.authenticate(rawToken);
    if (!auth.user.platformAdmin) throw saasError("FORBIDDEN", "需要平台管理员权限", 403);
    return this.store.adminMetrics();
  }

  adminMarkOrderPaid(rawToken, orderId) {
    const auth = this.authenticate(rawToken);
    if (!auth.user.platformAdmin) throw saasError("FORBIDDEN", "需要平台管理员权限", 403);
    return this.store.markOrderPaid(orderId, auth.user.id);
  }

  adminProcessRefund(rawToken, refundId, payload) {
    const auth = this.authenticate(rawToken);
    if (!auth.user.platformAdmin) throw saasError("FORBIDDEN", "需要平台管理员权限", 403);
    const value = object(payload, "退款处理");
    allowed(value, ["approved"], "退款处理");
    if (typeof value.approved !== "boolean") throw saasError("INVALID_INPUT", "退款处理结果无效");
    return this.store.processRefund(refundId, value.approved, auth.user.id);
  }
}
