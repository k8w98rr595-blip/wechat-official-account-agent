# 公众号写作 Agent

把一个粗浅想法逐步整理成可编辑的微信公众号文章。Agent 会先追问关键信息，再生成内容方向、正文草稿，并支持局部改写、发布检查和复制到公众号编辑器。

## 项目结构

```text
公众号agent/
├─ frontend/
│  ├─ public/          # 页面与交互逻辑
│  └─ styles/          # 全局样式
├─ backend/
│  ├─ server.mjs       # HTTP 服务与 API
│  └─ lib/             # Agent 编排及模型适配器
├─ tests/              # 自动化测试
├─ scripts/            # 构建检查
├─ docs/               # 产品说明与模型接入文档
└─ .github/workflows/  # GitHub Pages 自动部署
```

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm test
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。默认使用 Mock 模式，不需要 API 密钥。

## 接入真实模型

复制 `.env.example` 为 `.env.local`，然后设置：

```dotenv
AGENT_PROVIDER_MODE=openai-compatible
AGENT_BASE_URL=https://api.deepseek.com
AGENT_API_KEY=你的服务端密钥
AGENT_MODEL=deepseek-v4-flash
AGENT_MODEL_QUALITY=deepseek-v4-pro
AGENT_THINKING_MODE=operation-based
AGENT_ACCESS_TOKEN=另设的随机访问码
```

密钥只应配置在服务端或托管平台的环境变量中，不能写入前端或提交到 GitHub。详细说明见 [模型接入教程](docs/lessons/0001-connect-an-openai-compatible-model.html)。

## GitHub Pages 部署

现有 GitHub Pages 地址会直接连接 DeepSeek V4。第一次使用真实 AI 时，网页会要求输入 DeepSeek API Key；Key 仅保存在当前标签页的 `sessionStorage`，关闭标签页后自动清除，不会写入 GitHub 或 IndexedDB。详见 [DeepSeek V4 部署说明](docs/deploy-deepseek-v4.md)。

推送到 GitHub 仓库的 `main` 分支后，`Deploy GitHub Pages` 工作流会自动测试、构建并发布网站。项目站点默认地址为：

```text
https://<GitHub用户名>.github.io/<仓库名>/
```

GitHub Pages 是静态托管：未配置 `AGENT_API_BASE_URL` 时，由浏览器使用用户临时输入的 Key 直接调用 DeepSeek；配置该变量后，也可以切换到独立部署的 `backend/`。任何 Key 都不能写入仓库或构建产物。

## 数据说明

- 草稿和品牌信息保存在当前浏览器的 IndexedDB 中。
- 服务端不保存文章内容或用户账户。
- 公网 API 默认按来源地址限制为每分钟 30 次请求。
