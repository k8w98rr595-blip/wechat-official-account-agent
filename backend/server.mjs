import http from "node:http";
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
  ["/mock-agent.js", ["frontend/public/mock-agent.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["frontend/styles/globals.css", "text/css; charset=utf-8"]],
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

export function createServer(options = {}) {
  const rateLimitMax = Number(options.rateLimitMax ?? process.env.RATE_LIMIT_MAX ?? 30);
  const rateLimitWindowMs = Number(options.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === "1";
  const requestsByAddress = new Map();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        providerMode: process.env.AGENT_PROVIDER_MODE || "mock",
      });
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
        return json(response, 429, { error: "请求过于频繁，请稍后重试" }, { "retry-after": String(retryAfter) });
      }

      try {
        return json(response, 200, await runAgentOperation(operation, await readJson(request)));
      } catch (error) {
        const status = error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
        return json(response, status, {
          error: error instanceof Error ? error.message : "Agent 处理失败",
        });
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
          "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
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
