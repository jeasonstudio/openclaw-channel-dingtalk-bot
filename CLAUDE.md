# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an OpenClaw plugin that provides DingTalk (钉钉) channel integration using a **Webhook + SessionWebhook** pattern. It allows OpenClaw bots to receive messages via HTTP webhooks and reply using DingTalk's session webhook URLs.

## Architecture

The plugin follows the OpenClaw ChannelPlugin interface structure:

```
src/
├── index.ts          # Plugin entry point - exports plugin with register(api) function
├── channel.ts         # Core ChannelPlugin implementation (config/outbound/gateway/webhook logic)
├── runtime.ts         # PluginRuntime storage getter/setter
├── sign.ts            # DingTalk HMAC-SHA256 signature generation
└── types.ts           # TypeScript interfaces for config and inbound messages
```

**Key Components:**

- **Plugin Registration** (`src/index.ts`): Creates the plugin object with `register(api)` function that registers the channel with OpenClaw
- **DingTalk Channel** (`src/channel.ts`): Main `ChannelPlugin` implementation containing:
  - `gateway.startAccount`: Registers HTTP route at `/dingtalk-channel/message` with OpenClaw gateway
  - `gateway.stopAccount`: Unregisters the route
  - `outbound.sendText`: Sends messages via cached session webhooks
  - `config`: Handles single-account resolution with `secretKey`
- **Message Flow**: Inbound POST → Token auth → Parse text/richText → Agent dispatch → Session webhook reply with signature

## Development Commands

```bash
# Type check
npm run type-check

# Lint
npm run lint

# Fix lint issues
npm run lint:fix
```

Note: This project does not have test commands per development constraints.

## Configuration

Plugin is configured in `~/.openclaw/openclaw.json`:

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

- `secretKey`: Required - DingTalk robot security key (starts with "SEC")
- `enabled`: Optional - defaults to `true`
- Single-account mode only - account ID is fixed to `"default"`

## Inbound Message Processing

**Authentication:** Request header `token` must be a prefix of `secretKey` (`secretKey.startsWith(token)`)

**Supported Message Types:**
- `msgtype = "text"`: Parses `text.content` and trims
- `msgtype = "richText"`: Parses `content.richText` nodes:
  - Text nodes: concatenated in order
  - Picture nodes: downloaded via DingTalk API (requires `DINGTALK_ACCESS_TOKEN` env var) or fallback to `[图片 downloadCode=xxx]`

**Group Message Handling:**
- Only processes group messages if the bot was mentioned
- Checks `isInAtList` or `atUsers` contains `chatbotUserId`

**RichText Image Download:**
- API: `POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`
- Requires `DINGTALK_ACCESS_TOKEN` or `DINGTALK_APP_ACCESS_TOKEN` env var
- Requires `robotCode` field (fails if `"normal"` or missing)
- Automatically degrades to placeholder on failure

## Outbound Message Sending

Outbound replies use the `sessionWebhook` from the inbound payload:

1. Signature: `HMAC-SHA256(secretKey, "${timestamp}\n${secretKey}")` → base64 → urlEncode
2. URL: `{sessionWebhook}?timestamp={timestamp}&sign={sign}`
3. Payload:
   ```json
   {
     "msgtype": "markdown",
     "markdown": { "title": "[新的消息]", "text": "..." },
     "at": { "atMobiles": [], "atUserIds": [], "isAtAll": false }
   }
   ```

**Session Webhook Cache:**
- In-memory `Map<conversationId, { url, expiresAt }>` stored at message receipt
- Cleared after expiration or on restart (not persistent)

## Channel Routing

The plugin integrates with OpenClaw's routing system:

1. Resolves agent route based on channel (`dingtalk`), account (`default`), and peer (group/direct)
2. Formats message envelope with agent context
3. Creates reply dispatcher with typing simulation
4. Chunks text if needed (default 4000 char limit)
5. Dispatches to agent for processing

## Important Constraints

1. **No standalone service**: Route is registered to OpenClaw gateway via `registerPluginHttpRoute`, does not start its own HTTP server
2. **Single account**: Only one DingTalk account is supported (ID: `"default"`)
3. **Message types**: Only `text` and `richText` are processed; others are ignored
4. **Session webhook expiration**: Cached webhooks expire and are not persistent across restarts
5. **Webhook mode only**: This is a webhook-based integration, not a Stream/Card-based one

## Type Definitions

Key interfaces in `src/types.ts`:

- `DingTalkConfig`: Plugin config (`enabled`, `secretKey`)
- `ResolvedDingTalkAccount`: Resolved account with status
- `DingTalkInboundMessage`: Full inbound payload from DingTalk
- `DingTalkRichTextNode`: Rich text content nodes

## Environment Variables

- `DINGTALK_ACCESS_TOKEN` / `DINGTALK_APP_ACCESS_TOKEN`: Optional access token for downloading rich text images

## Package Configuration

- `main`: `"src/index.ts"` - ES module entry point
- `type`: `"module"` - Uses ES modules
- `openclaw.channel.id`: `"dingtalk"`
- `openclaw.extensions`: Points to `src/index.ts`

## Dependencies

Runtime: `axios`, `zod` (for config schema in OpenClaw SDK)
Dev: TypeScript, ESLint, Prettier
