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
AGENT_BASE_URL=https://api.openai.com/v1
AGENT_API_KEY=你的服务端密钥
AGENT_MODEL=你的模型名称
```

密钥只应配置在服务端或托管平台的环境变量中，不能写入前端或提交到 GitHub。详细说明见 [模型接入教程](docs/lessons/0001-connect-an-openai-compatible-model.html)。

## GitHub Pages 部署

推送到 GitHub 仓库的 `main` 分支后，`Deploy GitHub Pages` 工作流会自动测试、构建并发布网站。项目站点默认地址为：

```text
https://<GitHub用户名>.github.io/<仓库名>/
```

GitHub Pages 是静态托管，公开版会自动使用浏览器内置 Mock Agent，因此不需要 API 密钥，访谈、生成方向、生成正文、局部改写和发布检查均可运行。

若要启用真实模型，需要另外部署 `backend/`，并把模型密钥保存在后端环境变量中。不能把密钥写入 GitHub Pages 前端。

## 数据说明

- 草稿和品牌信息保存在当前浏览器的 IndexedDB 中。
- 服务端不保存文章内容或用户账户。
- 公网 API 默认按来源地址限制为每分钟 30 次请求。
