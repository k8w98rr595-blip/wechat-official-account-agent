# Mission: 为公众号写作 Agent 接入真实模型

## Why
让当前只能使用 Mock 数据的本机写作工作台能够调用真实大模型，完成营销访谈、标题策划、正文生成、局部改写和事实审计。

## Success looks like
- 能识别并正确填写 Base URL、API Key 和模型 ID
- 能安全创建 `.env.local`，不把密钥写进前端或 Git
- 能启动应用并确认 `providerMode` 为 `openai-compatible`
- 能独立判断常见的 401、404、429 和超时问题

## Constraints
- 当前应用运行在 Windows 本机
- 模型供应商尚未确定，教程以 OpenAI-compatible `chat/completions` 为共同接口
- 密钥不得粘贴到聊天或提交到仓库

## Out of scope
- 模型微调、RAG 知识库、多模型路由
- 公开部署后的账号、计费和密钥托管
