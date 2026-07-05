# 将 GitHub Pages 接入 DeepSeek V4

## 生产入口

唯一生产入口为：

`https://k8w98rr595-blip.github.io/wechat-official-account-agent/`

GitHub Pages 在浏览器中直接调用 DeepSeek 官方 API，不需要 Render 等额外托管账号。DeepSeek 已允许该 Pages 域名跨域请求。

## 使用方式

1. 打开生产网址并新建文章。
2. 第一次调用真实 AI 时，在密码输入框中填写 DeepSeek API Key。
3. Key 只保存在当前标签页的 `sessionStorage` 中，并直接发送到 `https://api.deepseek.com`。
4. 关闭标签页后 Key 自动清除，下次使用需要重新输入。

## 模型分工

- 访谈、内容方向、局部改写：`deepseek-v4-flash`，关闭思考模式。
- 正文成稿、发布审核：`deepseek-v4-pro`，开启高强度思考模式。
- 所有响应使用 JSON Output，并执行结构校验和文章 HTML 清洗。

## 安全边界

- Key 不得写入源码、GitHub Actions、构建产物、IndexedDB 或聊天。
- 该方案适合个人生产工具。浏览器扩展、恶意脚本或 GitHub 账号被入侵时，标签页中的 Key 仍可能暴露。
- 页面不加载第三方脚本，模型生成 HTML 会经过标签和属性清洗。
- 如果未来开放给多人使用，应改为带账号认证、共享限流和服务端 Secret 的独立后端。
