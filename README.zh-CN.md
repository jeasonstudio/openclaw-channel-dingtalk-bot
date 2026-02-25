# OpenClaw 的 DingTalk Channel 插件

一个面向生产环境的 OpenClaw DingTalk 渠道插件，采用 **Webhook + SessionWebhook** 架构。

本插件通过 OpenClaw gateway 接收钉钉机器人回调，并通过会话级 webhook 以钉钉规范签名回发消息。

## 为什么选择本插件

- 无需额外启动独立服务，即可把钉钉机器人接入 OpenClaw
- 配置项极简（仅 `secretKey` 为必填）
- 支持纯文本和富文本入站消息
- 支持群聊 @ 提及过滤，避免无效触发
- 出站请求遵循钉钉 HMAC-SHA256 签名规则

## 与其他 DingTalk Channel 的定位对比

相比许多基于钉钉开放平台应用（需要 `appKey` + `appSecret`，常见 Stream 模式）的开源
DingTalk Channel，本项目刻意选择了 **自定义机器人（Custom Robot）** 模式。

### 核心优势

- **接入成本更低、上线更快：** 不需要申请开放平台应用凭证（`appKey`/`appSecret`），只需 `secretKey`。
- **默认交互边界更安全：** 自定义机器人以群会话为主，不支持常规 1:1 单聊，可降低私聊场景下的误泄露风险。
- **运维复杂度更低：** Webhook 回调 + SessionWebhook 回发，架构直接，部署与排查更简单。

### 权衡取舍

| 维度 | 本插件（自定义机器人） | App/Stream 类方案 |
| --- | --- | --- |
| 凭证配置 | 仅 `secretKey` | `appKey` + `appSecret` |
| 消息接入模式 | Webhook 回调 | 通常是 Stream 或事件订阅 |
| 网络要求 | 需要将 OpenClaw gateway 回调地址对外暴露 | 某些 Stream 部署可不暴露公网回调 |
| 1:1 单聊支持 | 不支持（群场景为主） | 通常支持 |

总结：本插件优先优化 **方便快捷、门槛低、群场景更安全**，同时接受不能使用钉钉 Stream 模式、并依赖对外暴露 OpenClaw gateway 的前提。

## 架构概览

- **入站：** 钉钉 `POST` 回调 -> OpenClaw gateway 路由 -> 消息解析/鉴权 -> agent 分发
- **回复出站：** 入站触发的回复使用 `sessionWebhook` 并签名发送
- **主动出站：** 定时/主动投递使用 `robot/send` + `accessToken`
- **运行模式：** 单账号（`accountId = "default"`）

## 安装

### 从 npm 安装（推荐）

```bash
openclaw plugins install openclaw-channel-dingtalk-bot
```

OpenClaw 的 npm 插件安装参数应为 registry 包名（可选版本或 tag）。

### 从 GitHub 安装

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
      "secretKey": "SECxxxxxxxx",
      "webhookPath": "/dingtalk-channel/message",
      "accessToken": "dt_access_token_xxx"
    }
  }
}
```

- `secretKey`（必填）：钉钉机器人安全密钥（通常以 `SEC` 开头）
- `enabled`（可选）：默认 `true`
- `webhookPath`（可选）：入站回调路径，默认 `/dingtalk-channel/message`
- `accessToken`（可选）：用于富文本图片下载和主动出站投递的钉钉 access token

## 钉钉回调设置

在钉钉机器人配置中，将回调地址设置为与 `webhookPath` 一致：

```text
https://<your-gateway-host>/dingtalk-channel/message
```

示例：

```text
https://your-domain.com/dingtalk-channel/message
```

## 入站消息处理

### 鉴权

插件使用如下规则校验请求头 `token`：

```text
secretKey === token
```

校验失败会返回 HTTP `401`。

### 支持的消息类型

- `msgtype = "text"`：解析并 trim `text.content`
- `msgtype = "richText"`：解析并拼接 `content.richText` 文本节点

对于 richText 图片节点，插件会尝试通过以下接口解析临时下载地址：

- `POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`
- Header：`x-acs-dingtalk-access-token`
- Body：`{ downloadCode, robotCode }`
- token 来源：`channels.dingtalk.accessToken`

如果下载失败（token 缺失、`robotCode` 无效或 API 报错），插件会优雅降级为占位文本，例如 `[image downloadCode=xxx]`。

### 群聊 @ 处理规则

群聊中仅在机器人被 @ 时处理消息（`isInAtList` 或 `atUsers` 匹配）。

## 出站消息与签名

插件包含两条出站路径：

- 回复出站（由入站消息触发）：`sessionWebhook`
- 主动出站（定时/手动投递）：`POST https://oapi.dingtalk.com/robot/send`

仅当配置了 `channels.dingtalk.accessToken` 时，主动出站才可用；未配置时默认不支持主动出站。

签名算法：

1. `timestamp = Date.now()`
2. `textToSign = "${timestamp}\n${secretKey}"`
3. `sign = encodeURIComponent(base64(HMAC_SHA256(secretKey, textToSign)))`
4. 最终 URL：
   - 回复出站：`{sessionWebhook}&timestamp={timestamp}&sign={sign}`
   - 主动出站：`https://oapi.dingtalk.com/robot/send?access_token={accessToken}&timestamp={timestamp}&sign={sign}`

### 签名示例（Node.js）

```ts
import crypto from 'node:crypto';

export function dingtalkSign(secretKey: string) {
  const timestamp = Date.now();
  const textToSign = `${timestamp}\n${secretKey}`;
  const base64 = crypto.createHmac('sha256', secretKey).update(textToSign).digest('base64');
  return { timestamp, sign: encodeURIComponent(base64) };
}
```

### SessionWebhook 发送示例

```ts
import axios from 'axios';

async function sendBySessionWebhook(sessionWebhook: string, secretKey: string, text: string) {
  const { timestamp, sign } = dingtalkSign(secretKey);
  const url = `${sessionWebhook}&timestamp=${timestamp}&sign=${sign}`;

  await axios.post(
    url,
    {
      msgtype: 'markdown',
      markdown: { title: '[New Message]', text },
      at: { atMobiles: [], atUserIds: [], isAtAll: false },
    },
    { headers: { 'Content-Type': 'application/json' } },
  );
}
```

### AccessToken 发送示例

```ts
import axios from 'axios';

async function sendByAccessToken(accessToken: string, secretKey: string, text: string) {
  const { timestamp, sign } = dingtalkSign(secretKey);
  const url =
    `https://oapi.dingtalk.com/robot/send?access_token=${accessToken}` +
    `&timestamp=${timestamp}&sign=${sign}`;

  await axios.post(
    url,
    {
      msgtype: 'markdown',
      markdown: { title: '[New Message]', text },
      at: { atMobiles: [], atUserIds: [], isAtAll: false },
    },
    { headers: { 'Content-Type': 'application/json' } },
  );
}
```

## 入站 Payload 示例

```json
{
  "senderPlatform": "Mac",
  "conversationId": "cid5DEAySu/Fk+mtMwii4NLYQ==",
  "atUsers": [{ "dingtalkId": "$:LWCP_v1:$IHInSnicgNoAQhIiY9O0VGFxjAzvyVUf" }],
  "chatbotUserId": "$:LWCP_v1:$IHInSnicgNoAQhIiY9O0VGFxjAzvyVUf",
  "msgId": "msg/aa4qSVItb20ufU89R4V1A==",
  "senderNick": "User",
  "sessionWebhookExpiredTime": 1770982588732,
  "conversationType": "2",
  "isInAtList": true,
  "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
  "text": { "content": "hello" },
  "robotCode": "normal",
  "msgtype": "text"
}
```

## 端到端流程

1. 钉钉将回调发送到 `webhookPath`
2. 插件校验 token 并解析入站 payload
3. 消息被路由到 OpenClaw agent 分发
4. agent 响应通过签名后的 `sessionWebhook` markdown 消息回发
5. 定时/主动出站在配置 `accessToken` 后通过机器人接口投递

## 开发

```bash
npm run build
npm run type-check
npm run lint
npm run lint:fix
```

如果你要发布到 npm，建议先执行 `npm run build`，再执行 `npm publish`。

## 当前限制

- 入站解析仅处理 `text` 与 `richText`
- 主动出站依赖 `channels.dingtalk.accessToken`
- 仅支持单账号模型（`default`）

## License

MIT
