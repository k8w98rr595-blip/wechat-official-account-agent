# 模型接入资源

## Knowledge

- [项目运行与模型配置说明](./README.md)
  当前应用的权威运行说明。用于确认 `.env.local` 字段和启动命令。
- [应用模型适配器源码](../backend/lib/agent-core.mjs)
  当前实现的最终事实来源。用于确认应用会请求 `${AGENT_BASE_URL}/chat/completions`，并使用 Bearer Key。
- [OpenAI Chat Completions API Reference](https://platform.openai.com/docs/api-reference/chat/create-chat-completion)
  官方接口规范。使用 OpenAI 时用于核对请求路径、消息结构和返回格式。
- [OpenAI API Key Safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)
  官方密钥安全建议。用于判断密钥应该保存在哪里，以及泄漏后如何处理。

## Wisdom (Communities)

- 你所选模型供应商的官方开发者支持渠道
  用于核实模型 ID、账户配额、区域限制和供应商特有错误码；这些信息不能由通用兼容规范替代。

## Gaps

- 供应商尚未确定，因此还不能给出唯一的 Base URL、模型 ID 和充值入口。
