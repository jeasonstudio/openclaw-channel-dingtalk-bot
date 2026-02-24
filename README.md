# DingTalk Channel Plugin for OpenClaw

[简体中文文档](README.zh-CN.md)

A production-oriented OpenClaw channel plugin for DingTalk using a **Webhook + SessionWebhook** architecture.

This plugin receives DingTalk robot callbacks through the OpenClaw gateway and sends replies back through per-session webhooks with DingTalk-compliant signatures.

## Why This Plugin

- Integrates DingTalk robots with OpenClaw without running an extra standalone service
- Keeps configuration minimal (`secretKey` is the only required field)
- Supports both plain text and rich text inbound messages
- Handles group mention filtering to avoid unnecessary bot triggers
- Signs outbound requests with DingTalk HMAC-SHA256 rules

## Positioning vs Other DingTalk Channels

Compared with many open-source DingTalk channels that are based on DingTalk Open Platform apps
(`appKey` + `appSecret`, often with Stream mode), this project intentionally uses **Custom Robot**
mode.

### Main Advantages

- **Lower setup cost and faster launch:** no need to apply for Open Platform app credentials
  (`appKey`/`appSecret`), only `secretKey` is required.
- **Safer default interaction boundary:** Custom Robot mode is group-oriented and does not support
  regular 1:1 direct chat with the bot, which helps reduce accidental private information leakage.
- **Operational simplicity:** webhook callback + session webhook reply keeps the architecture easy
  to understand and deploy.

### Trade-offs

| Dimension | This Plugin (Custom Robot) | App/Stream-based Channels |
| --- | --- | --- |
| Credential setup | `secretKey` only | `appKey` + `appSecret` |
| Delivery mode | Webhook callback | Usually Stream or event subscription |
| Network requirement | Must expose OpenClaw gateway callback URL | Stream mode can avoid public callback exposure in some setups |
| 1:1 DM support | Not supported (group-centric) | Usually supported |

In short: this plugin optimizes for **convenience, low barrier, and safer group-only usage**, while
accepting the limitation that it cannot use DingTalk Stream mode and therefore depends on exposing
the OpenClaw gateway to the public network.

## Architecture Overview

- **Inbound:** DingTalk `POST` callback -> OpenClaw gateway route -> message parsing/auth -> agent dispatch
- **Outbound:** OpenClaw agent response -> cached `sessionWebhook` -> signed DingTalk markdown message
- **Runtime mode:** single account (`accountId = "default"`)

## Installation

### Install from npm (recommended)

```bash
openclaw plugins install openclaw-channel-dingtalk-bot
```

OpenClaw plugin npm specs are registry package names (optionally with versions/tags).

### Install from GitHub

```bash
openclaw plugins install https://github.com/jeasonstudio/openclaw-channel-dingtalk-bot.git
```

### Install locally

```bash
git clone https://github.com/jeasonstudio/openclaw-channel-dingtalk-bot.git
cd openclaw-channel-dingtalk-bot
npm install
openclaw plugins install -l .
```

## Configuration

Configure OpenClaw in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "secretKey": "SECxxxxxxxx",
      "webhookPath": "/dingtalk-channel/message"
    }
  }
}
```

- `secretKey` (required): DingTalk bot security key (typically starts with `SEC`)
- `enabled` (optional): defaults to `true`
- `webhookPath` (optional): inbound callback path, defaults to `/dingtalk-channel/message`

## DingTalk Callback Setup

In DingTalk bot settings, configure the callback URL to match `webhookPath`:

```text
https://<your-gateway-host>/dingtalk-channel/message
```

Example:

```text
https://your-domain.com/dingtalk-channel/message
```

## Inbound Message Handling

### Authentication

The plugin validates request header `token` with:

```text
secretKey === token
```

If validation fails, it returns HTTP `401`.

### Supported Message Types

- `msgtype = "text"`: parses and trims `text.content`
- `msgtype = "richText"`: parses and concatenates `content.richText` text nodes

For rich text image nodes, the plugin attempts to resolve temporary image URLs via:

- `POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`
- Header: `x-acs-dingtalk-access-token`
- Body: `{ downloadCode, robotCode }`

Environment variables for access token:

- `DINGTALK_ACCESS_TOKEN`
- `DINGTALK_APP_ACCESS_TOKEN`

If download fails (missing token, invalid `robotCode`, or API error), the plugin degrades gracefully to a placeholder like `[image downloadCode=xxx]`.

### Group Mention Behavior

For group chats, inbound messages are processed only when the bot is mentioned (`isInAtList` or matching `atUsers`).

## Outbound Message and Signing

Outbound replies are sent as DingTalk markdown messages through `sessionWebhook`.

Signature algorithm:

1. `timestamp = Date.now()`
2. `textToSign = "${timestamp}\n${secretKey}"`
3. `sign = encodeURIComponent(base64(HMAC_SHA256(secretKey, textToSign)))`
4. final URL: `{sessionWebhook}&timestamp={timestamp}&sign={sign}`

### Signing Example (Node.js)

```ts
import crypto from 'node:crypto';

export function dingtalkSign(secretKey: string) {
  const timestamp = Date.now();
  const textToSign = `${timestamp}\n${secretKey}`;
  const base64 = crypto.createHmac('sha256', secretKey).update(textToSign).digest('base64');
  return { timestamp, sign: encodeURIComponent(base64) };
}
```

### Send by SessionWebhook Example

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

## Inbound Payload Example

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

## End-to-End Flow

1. DingTalk sends callback to `webhookPath`
2. Plugin validates token and parses inbound payload
3. Message is routed into OpenClaw agent dispatch
4. Agent response is delivered via signed `sessionWebhook` markdown message

## Development

```bash
npm run build
npm run type-check
npm run lint
npm run lint:fix
```

For npm publishing, run `npm run build` before `npm publish`.

## Current Limitations

- Only `text` and `richText` are handled for inbound parsing
- Session webhook mapping is in-memory only (not persisted across restarts)
- Single-account model only (`default`)

## License

MIT
