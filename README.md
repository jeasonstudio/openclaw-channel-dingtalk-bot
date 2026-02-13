# DingTalk Channel for OpenClaw

基于 **Webhook + SessionWebhook** 的 OpenClaw DingTalk Channel 插件。

这个插件面向“已创建好的钉钉机器人”场景：

- 入站：钉钉机器人把消息 POST 到 OpenClaw gateway 路由
- 出站：插件使用消息体里的 `sessionWebhook` 回发消息
- 鉴权：使用 `header.token` 与 `secretKey` 前缀匹配
- 签名：`HMAC-SHA256(secretKey, "${timestamp}\n${secretKey}")`

## 特性

- 固定 gateway 路由：`/dingtalk-channel/message`
- 配置简化：仅需一个 `secretKey`
- 无需额外启动独立服务（路由注册到 OpenClaw gateway）
- 默认回复 `markdown` 消息格式
- 兼容群聊 `@机器人` 场景（支持 `isInAtList` / `atUsers` 判断）

## 安装

### 远程安装

```bash
openclaw plugins install https://github.com/jeasonstudio/openclaw-channel-dingtalk-bot.git
```

### 本地安装

```bash
git clone https://github.com/jeasonstudio/openclaw-channel-dingtalk-bot.git
cd openclaw-channel-dingtalk-bot
npm install
openclaw plugins install -l .
```

## 配置

在 `~/.openclaw/openclaw.json` 中配置：

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "secretKey": "SECxxxxxxxx"
    }
  }
}
```

说明：

- `secretKey` 必填，对应钉钉机器人安全设置里的密钥
- 当前插件按单账号模式实现，账号 ID 固定为 `default`

## 钉钉侧配置

在钉钉机器人回调地址中填写：

`http(s)://<gateway-host>:<port>/dingtalk-channel/message`

例如：

`https://your-domain.com/dingtalk-channel/message`

## 入站消息格式（示例）

插件按以下结构解析钉钉消息（字段可有增减，关键字段如下）：

```json
{
  "senderPlatform": "Mac",
  "conversationId": "cid5DEAySu/Fk+mtMwii4NLYQ==",
  "atUsers": [{ "dingtalkId": "$:LWCP_v1:$IHInSnicgNoAQhIiY9O0VGFxjAzvyVUf" }],
  "chatbotUserId": "$:LWCP_v1:$IHInSnicgNoAQhIiY9O0VGFxjAzvyVUf",
  "openThreadId": "cid5DEAySu/Fk+mtMwii4NLYQ==",
  "msgId": "msg/aa4qSVItb20ufU89R4V1A==",
  "senderNick": "牧曈",
  "isAdmin": false,
  "sessionWebhookExpiredTime": 1770982588732,
  "createAt": 1770977188466,
  "conversationType": "2",
  "senderId": "$:LWCP_v1:$Fd9c3uDHnEuHxs4usGPblA==",
  "conversationTitle": "ChatGPT",
  "isInAtList": true,
  "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
  "text": { "content": " 你好" },
  "robotCode": "normal",
  "msgtype": "text"
}
```

处理要点：

- 仅处理 `msgtype = text`
- `text.content` 会做 `trim()`（兼容群里 `@` 后前导空格）
- 群聊消息默认仅在命中 `@机器人` 时进入 Agent 分发

## 鉴权与签名

### 入站鉴权

插件读取请求头 `token`，并执行：

`secretKey.startsWith(token)`

若不通过，返回 401。

### 出站签名

签名逻辑（Node.js）在 `src/sign.ts`：

1. `timestamp = Date.now()`
2. `textToSign = "${timestamp}\n${secretKey}"`
3. `HMAC_SHA256(secretKey, textToSign)` 并 base64
4. `encodeURIComponent(base64)` 得到 `sign`
5. 回调 URL：`sessionWebhook&timestamp=...&sign=...`

## 工作流程

1. DingTalk POST 消息到 `/dingtalk-channel/message`
2. 插件校验 token、解析消息
3. 通过 OpenClaw runtime 进入 Agent 管道（`dispatchReplyFromConfig`）
4. `deliver` 回调中使用 `sessionWebhook + 签名` 回发 markdown

## 开发命令

```bash
npm run type-check
npm run lint
npm run lint:fix
```

## 当前限制

- 当前文档与实现聚焦文本消息（`msgtype=text`）
- 未实现单测（按当前改造要求）
- `sessionWebhook` 使用内存缓存（重启后不保留历史会话映射）

## 许可

MIT
