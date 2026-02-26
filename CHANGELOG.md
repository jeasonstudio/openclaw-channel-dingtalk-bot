# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-02-26

### Added
- Config options for reply streaming and tool progress visibility:
  - `channels.dingtalk.blockStreaming`
  - `channels.dingtalk.toolProgress`
  - `channels.dingtalk.toolProgressInGroup`
- Tool progress notifications for DingTalk replies (simple mode), including:
  - `正在调用{工具名}...`
  - `正在调用工具...`
  - `正在处理工具结果...`
  - `工具调用已完成，正在整理答案...`
- Basic anti-spam throttling for repeated tool progress updates (1.5 seconds window).
- Documentation section for streaming and tool-progress behavior in `README.md`.

### Changed
- Reply delivery now uses OpenClaw dispatcher `kind` (`tool`/`block`/`final`) to control outbound behavior.
- Block replies are delivered incrementally when streaming is enabled, improving perceived latency.
- Bumped package version to `1.1.0` in:
  - `package.json`
  - `openclaw.plugin.json`
  - `package-lock.json`
