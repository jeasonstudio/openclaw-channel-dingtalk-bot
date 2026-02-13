# 使用示例

## 1) OpenClaw 配置示例

在 `~/.openclaw/openclaw.json` 中添加：

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

## 2) DingTalk 机器人回调地址

在钉钉机器人后台配置消息接收地址：

```text
https://<your-gateway-host>/dingtalk-channel/message
```

## 3) 入站 payload 示例

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

## 4) 回调签名（Node.js）

```ts
import crypto from 'node:crypto';

export function dingtalkSign(secretKey: string) {
  const timestamp = Date.now();
  const textToSign = `${timestamp}\n${secretKey}`;
  const base64 = crypto.createHmac('sha256', secretKey).update(textToSign).digest('base64');
  return { timestamp, sign: encodeURIComponent(base64) };
}
```

## 5) 会话回调发送 markdown 示例

```ts
import axios from 'axios';

async function sendBySessionWebhook(sessionWebhook: string, secretKey: string, text: string) {
  const { timestamp, sign } = dingtalkSign(secretKey);
  const url = `${sessionWebhook}&timestamp=${timestamp}&sign=${sign}`;
  await axios.post(
    url,
    {
      msgtype: 'markdown',
      markdown: { title: '[新的消息]', text },
      at: { atMobiles: [], atUserIds: [], isAtAll: false },
    },
    { headers: { 'Content-Type': 'application/json' } },
  );
}
```
