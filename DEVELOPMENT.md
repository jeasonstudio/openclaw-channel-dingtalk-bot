# 开发指南

## 当前代码结构

```text
openclaw-channel-dingtalk-bot/
├── src/
│   ├── index.ts      # OpenClaw 插件入口，register(api)
│   ├── channel.ts    # ChannelPlugin 核心逻辑（gateway/webhook/outbound）
│   ├── runtime.ts    # PluginRuntime getter/setter
│   ├── sign.ts       # 钉钉签名
│   └── types.ts      # 配置和消息类型
├── README.md
├── EXAMPLES.md
├── USAGE.md
├── package.json
└── tsconfig.json
```

## 本地开发

```bash
npm install
npm run type-check
npm run lint
```

## 关键实现说明

### 1. gateway 路由注册

- 路径固定：`/dingtalk-channel/message`
- 通过 `registerPluginHttpRoute` 注册到 OpenClaw gateway
- 不启动额外 HTTP 服务

### 2. 入站处理

- 请求头校验：`secretKey === token`
- 仅处理文本消息：`msgtype === 'text'`
- 统一 `text.content.trim()`
- 群聊只处理 `@机器人` 消息

### 3. 出站处理

- 使用入站 payload 提供的 `sessionWebhook`
- 发送 markdown 消息
- 发送前做签名：`timestamp + sign`

## 开发约束

- 配置项只保留 `secretKey`
- 保持实现简洁，避免引入复杂抽象
- 文档与代码必须同口径（Webhook，而非 Stream）

## 当前不包含

- 单元测试（当前改造阶段明确不写）
- 非文本消息完整处理
