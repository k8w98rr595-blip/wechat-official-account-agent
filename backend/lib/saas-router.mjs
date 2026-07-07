function organizationId(request) { return String(request.headers["x-organization-id"] || "").trim(); }

export async function routeSaasRequest({ request, url, service, readJson }) {
  const path = url.pathname;
  const method = request.method || "GET";
  const token = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const orgId = organizationId(request);

  if (method === "GET" && path === "/api/saas/plans") return { status: 200, body: { plans: service.plans() } };
  if (method === "POST" && path === "/api/saas/register") return { status: 201, body: await service.register(await readJson(request)) };
  if (method === "POST" && path === "/api/saas/login") return { status: 200, body: await service.login(await readJson(request)) };
  if (method === "POST" && path === "/api/saas/logout") { service.logout(token); return { status: 200, body: { ok: true } }; }
  if (method === "GET" && path === "/api/saas/me") return { status: 200, body: service.me(token) };
  if (method === "PATCH" && path === "/api/saas/profile") return { status: 200, body: service.updateProfile(token, await readJson(request)) };
  if (method === "POST" && path === "/api/saas/change-password") return { status: 200, body: await service.changePassword(token, await readJson(request)) };

  if (method === "GET" && path === "/api/saas/organization") return { status: 200, body: service.organization(token, orgId) };
  if (method === "PATCH" && path === "/api/saas/organization") return { status: 200, body: service.updateOrganization(token, orgId, await readJson(request)) };

  if (method === "GET" && path === "/api/saas/members") return { status: 200, body: service.members(token, orgId) };
  if (method === "POST" && path === "/api/saas/members") return { status: 201, body: service.addMember(token, orgId, await readJson(request)) };
  const memberMatch = path.match(/^\/api\/saas\/members\/([a-z0-9-]{1,80})$/i);
  if (memberMatch && method === "PATCH") return { status: 200, body: service.updateMember(token, orgId, memberMatch[1], await readJson(request)) };
  if (memberMatch && method === "DELETE") return { status: 200, body: service.removeMember(token, orgId, memberMatch[1]) };

  if (method === "GET" && path === "/api/saas/workspace") return { status: 200, body: service.getWorkspace(token, orgId) };
  if (method === "PUT" && path === "/api/saas/workspace") return { status: 200, body: service.saveWorkspace(token, orgId, await readJson(request, 15_000_000)) };

  if (method === "GET" && path === "/api/saas/subscription") return { status: 200, body: service.subscription(token, orgId) };
  if (method === "GET" && path === "/api/saas/orders") return { status: 200, body: service.orders(token, orgId) };
  if (method === "POST" && path === "/api/saas/orders") return { status: 201, body: service.createOrder(token, orgId, await readJson(request)) };
  const refundRequestMatch = path.match(/^\/api\/saas\/orders\/([a-z0-9-]{1,80})\/refund$/i);
  if (refundRequestMatch && method === "POST") return { status: 201, body: service.requestRefund(token, orgId, refundRequestMatch[1], await readJson(request)) };

  if (method === "GET" && path === "/api/saas/admin/metrics") return { status: 200, body: service.adminMetrics(token) };
  const paidMatch = path.match(/^\/api\/saas\/admin\/orders\/([a-z0-9-]{1,80})\/paid$/i);
  if (paidMatch && method === "POST") return { status: 200, body: service.adminMarkOrderPaid(token, paidMatch[1]) };
  const refundProcessMatch = path.match(/^\/api\/saas\/admin\/refunds\/([a-z0-9-]{1,80})\/process$/i);
  if (refundProcessMatch && method === "POST") return { status: 200, body: service.adminProcessRefund(token, refundProcessMatch[1], await readJson(request)) };

  return undefined;
}
