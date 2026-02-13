/**
 * DingTalk Channel Plugin for OpenClaw
 *
 * 当前版本采用 Webhook 模式，不使用 Stream 模式。
 *
 * ## 配置
 *
 * 在 `~/.openclaw/openclaw.json` 中：
 *
 * ```json
 * {
 *   "channels": {
 *     "dingtalk": {
 *       "enabled": true,
 *       "secretKey": "SECxxxxxxxx"
 *     }
 *   }
 * }
 * ```
 *
 * ## 钉钉回调地址
 *
 * 将机器人回调 URL 指向：
 *
 * `http(s)://<gateway-host>:<port>/dingtalk-channel/message`
 *
 * ## 行为说明
 *
 * - 入站：校验 `header.token` 是否为 `secretKey` 前缀
 * - 入站：仅处理 `msgtype=text`
 * - 入站：群消息要求命中 @ 机器人（`isInAtList` / `atUsers`）
 * - 出站：默认发送 markdown 到 `sessionWebhook`
 * - 出站：每次发送附带 `timestamp + sign`（HMAC-SHA256）
 */
