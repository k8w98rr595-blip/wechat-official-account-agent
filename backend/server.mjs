import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAgentOperation } from "./lib/agent-core.mjs";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(backendDir, "..");
const staticFiles = new Map([
  ["/", ["frontend/public/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["frontend/public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["frontend/public/app.js", "text/javascript; charset=utf-8"]],
  ["/agent-core.js", ["backend/lib/agent-core.mjs", "text/javascript; charset=utf-8"]],
  ["/config.js", ["frontend/public/config.js", "text/javascript; charset=utf-8"]],
  ["/mock-agent.js", ["frontend/public/mock-agent.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["frontend/styles/globals.css", "text/css; charset=utf-8"]],
  ["/vendor/phosphor-regular.woff2", ["frontend/public/vendor/phosphor-regular.woff2", "font/woff2"]],
]);

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 1_000_000) {
      const error = new Error("请求内容过大");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
  }
  return JSON.parse(body || "{}");
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return request.socket.remoteAddress || "unknown";
}

function parseAllowedOrigins(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean));
}

function corsHeaders(request, allowedOrigins) {
  const origin = String(request.headers.origin || "").replace(/\/$/, "");
  if (!origin) return {};
  try {
    if (new URL(origin).host === request.headers.host) return {};
  } catch {
    return null;
  }
  if (!allowedOrigins.has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function tokensEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createServer(options = {}) {
  const rateLimitMax = Number(options.rateLimitMax ?? process.env.RATE_LIMIT_MAX ?? 30);
  const rateLimitWindowMs = Number(options.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === "1";
  const providerMode = options.providerMode ?? process.env.AGENT_PROVIDER_MODE ?? "mock";
  const accessToken = String(options.accessToken ?? process.env.AGENT_ACCESS_TOKEN ?? "");
  const allowUnauthenticatedAgent = options.allowUnauthenticatedAgent ?? process.env.ALLOW_UNAUTHENTICATED_AGENT === "1";
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS);
  const requestsByAddress = new Map();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const apiRequest = url.pathname.startsWith("/api/");
    const cors = apiRequest ? corsHeaders(request, allowedOrigins) : {};
    if (apiRequest && cors === null) return json(response, 403, { error: "请求来源不允许" });

    if (request.method === "OPTIONS" && apiRequest) {
      response.writeHead(204, { ...cors, "cache-control": "no-store" });
      return response.end();
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        providerMode,
        accessProtected: Boolean(accessToken),
      }, cors);
    }

    const operation = url.pathname.match(/^\/api\/agent\/(interview|directions|draft|rewrite|audit)$/)?.[1];
    if (request.method === "POST" && operation) {
      const now = Date.now();
      const address = clientAddress(request, trustProxy);
      const current = requestsByAddress.get(address);
      const bucket = !current || now - current.startedAt >= rateLimitWindowMs
        ? { startedAt: now, count: 0 }
        : current;
      bucket.count += 1;
      requestsByAddress.set(address, bucket);

      if (Number.isFinite(rateLimitMax) && rateLimitMax > 0 && bucket.count > rateLimitMax) {
        const retryAfter = Math.max(1, Math.ceil((rateLimitWindowMs - (now - bucket.startedAt)) / 1000));
        return json(response, 429, { error: "请求过于频繁，请稍后重试" }, { ...cors, "retry-after": String(retryAfter) });
      }

      if (providerMode !== "mock" && !accessToken && !allowUnauthenticatedAgent) {
        return json(response, 503, { error: "真实 AI 服务尚未完成访问保护配置" }, cors);
      }
      if (accessToken && !tokensEqual(bearerToken(request), accessToken)) {
        return json(response, 401, { error: "访问码无效" }, { ...cors, "www-authenticate": "Bearer" });
      }

      try {
        return json(response, 200, await runAgentOperation(operation, await readJson(request)), cors);
      } catch (error) {
        const requestId = randomUUID();
        const status = error?.code === "PAYLOAD_TOO_LARGE" ? 413
          : error?.code === "INVALID_INPUT" ? 400
            : error?.code === "CONFIG_ERROR" ? 503
              : error?.code === "PROVIDER_ERROR" ? 502
                : 500;
        console.error("Agent request failed", { requestId, operation, code: error?.code || "UNEXPECTED", name: error?.name || "Error" });
        const errorMessage = status < 500 && error instanceof Error ? error.message
          : status === 502 ? "AI 服务暂时不可用，请稍后重试"
            : status === 503 ? "AI 服务尚未完成配置"
              : "Agent 处理失败";
        return json(response, status, { error: errorMessage, requestId }, cors);
      }
    }

    const asset = staticFiles.get(url.pathname);
    if (request.method === "GET" && asset) {
      try {
        const body = await readFile(path.join(projectRoot, asset[0]));
        response.writeHead(200, {
          "content-type": asset[1],
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
          "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.deepseek.com",
        });
        return response.end(body);
      } catch {
        return json(response, 404, { error: "文件不存在" });
      }
    }

    return json(response, 404, { error: "页面不存在" });
  });
}

export async function loadLocalEnv() {
  try {
    const content = await readFile(path.join(projectRoot, ".env.local"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || match[1].startsWith("#") || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadLocalEnv();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => console.log(`公众号写作 Agent: http://${host}:${port}`));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
