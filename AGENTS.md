# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the OpenClaw DingTalk channel plugin source.
  - `src/index.ts` registers the plugin with OpenClaw.
  - `src/channel.ts` implements gateway/webhook handling and outbound replies.
  - `src/runtime.ts`, `src/sign.ts`, `src/types.ts` provide storage, signing, and types.
- `dist/` holds build artifacts when produced.
- `README.md` documents usage and configuration.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run type-check`: run TypeScript type checks (`tsc --noEmit`).
- `npm run lint`: run ESLint over `src/`.
- `npm run lint:fix`: auto-fix lint issues and format with Prettier.

There is no build or test script in this repo; use the commands above for CI-style checks.

## Coding Style & Naming Conventions
- TypeScript, ES modules (`"type": "module"`).
- Prettier settings: 2-space indentation, single quotes, semicolons, max line length 100.
- Keep files small and focused; prefer explicit naming (`DingTalkInboundMessage`, `resolveWebhookPath`).
- Avoid introducing additional abstractions unless clearly justified by functionality.

## Testing Guidelines
- No test framework or test suite is configured.
- If adding tests, place them under a new `tests/` directory and document how to run them in `package.json` and `README.md`.

## Commit & Pull Request Guidelines
- Commit history uses short, imperative sentences with sentence case (e.g., “Update README to…”, “Refactor imports…”).
- Keep commits focused; include rationale in the body if behavior changes.
- Pull requests should include:
  - A concise summary and motivation.
  - Linked issues if applicable.
  - Configuration or routing changes (e.g., `webhookPath`) highlighted.

## Configuration & Security Notes
- Channel config is read from `~/.openclaw/openclaw.json`.
  - Required: `secretKey` (DingTalk robot security key).
  - Optional: `webhookPath` (defaults to `/dingtalk-channel/message`).
- Optional env vars: `DINGTALK_ACCESS_TOKEN` or `DINGTALK_APP_ACCESS_TOKEN` for rich-text image downloads.
- Do not log secrets; keep token handling limited to request validation and signing.
