import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const required = [
  "backend/server.mjs",
  "backend/lib/agent-core.mjs",
  "frontend/public/index.html",
  "frontend/public/app.js",
  "frontend/public/mock-agent.js",
  "frontend/styles/globals.css",
  ".github/workflows/pages.yml",
];

for (const file of required) {
  await access(new URL(`../${file}`, import.meta.url));
}

for (const file of [
  "backend/server.mjs",
  "backend/lib/agent-core.mjs",
  "frontend/public/app.js",
  "frontend/public/mock-agent.js",
]) {
  const result = spawnSync(
    process.execPath,
    ["--check", fileURLToPath(new URL(`../${file}`, import.meta.url))],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `${file} 语法检查失败`);
  }
}

const html = await readFile(new URL("../frontend/public/index.html", import.meta.url), "utf8");
if (!html.includes("公众号写作 Agent") || !html.includes("./app.js") || !html.includes("./styles.css")) {
  throw new Error("入口页面不完整");
}

console.log("Build check passed");
