import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "dist");
if (!outputDir.startsWith(`${projectRoot}${path.sep}`)) throw new Error("Pages 输出目录越界");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const [source, target] of [
  ["frontend/public/index.html", "index.html"],
  ["frontend/public/app.js", "app.js"],
  ["frontend/public/mock-agent.js", "mock-agent.js"],
  ["frontend/styles/globals.css", "styles.css"],
]) {
  await copyFile(path.join(projectRoot, source), path.join(outputDir, target));
}

const html = await readFile(path.join(outputDir, "index.html"), "utf8");
if (!html.includes('./app.js') || !html.includes('./styles.css')) {
  throw new Error("GitHub Pages 产物必须使用相对资源路径");
}

await writeFile(path.join(outputDir, ".nojekyll"), "", "utf8");
console.log(`GitHub Pages artifact: ${outputDir}`);
