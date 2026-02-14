import axios from 'axios';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixContext,
  registerPluginHttpRoute,
} from 'openclaw/plugin-sdk';
import type {
  ChannelMeta,
  ChannelPlugin,
  OpenClawConfig,
  ReplyPayload,
} from 'openclaw/dist/plugin-sdk/index.js';
import { getRuntime } from './runtime';
import { dingtalkSign } from './sign';
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  DingTalkRichTextNode,
  ResolvedDingTalkAccount,
} from './types';

const WEBHOOK_PATH = '/dingtalk-channel/message';
const CHANNEL_ID = 'dingtalk';

const webhookByConversation = new Map<string, { url: string; expiresAt: number }>();
const routeUnregisterByAccount = new Map<string, () => void>();

const meta: ChannelMeta = {
  id: CHANNEL_ID,
  label: 'DingTalk',
  selectionLabel: 'DingTalk (钉钉)',
  docsPath: '/channels/dingtalk',
  docsLabel: 'dingtalk',
  blurb: '钉钉机器人 Webhook 模式，通过 OpenClaw gateway 接收并回复消息。',
  aliases: ['dd', 'ding'],
  order: 70,
};

function resolveDingTalkConfig(cfg: OpenClawConfig): DingTalkConfig {
  const channelCfg = (cfg.channels as Record<string, unknown> | undefined)?.[
    CHANNEL_ID
  ] as Partial<DingTalkConfig> | undefined;

  return {
    enabled: channelCfg?.enabled ?? true,
    secretKey: typeof channelCfg?.secretKey === 'string' ? channelCfg.secretKey.trim() : '',
  };
}

function resolveDingTalkAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedDingTalkAccount {
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const conf = resolveDingTalkConfig(cfg);
  return {
    accountId: resolvedAccountId,
    enabled: conf.enabled !== false,
    secretKey: conf.secretKey,
  };
}

function readTokenHeader(req: IncomingMessage): string {
  const raw = req.headers.token;
  if (Array.isArray(raw)) {
    return raw[0] ?? '';
  }
  return typeof raw === 'string' ? raw : '';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function sendMarkdownBySessionWebhook(params: {
  sessionWebhook: string;
  secretKey: string;
  text: string;
}): Promise<void> {
  const { sessionWebhook, secretKey, text } = params;
  const { timestamp, sign } = dingtalkSign(secretKey);
  const separator = sessionWebhook.includes('?') ? '&' : '?';
  const signedUrl = `${sessionWebhook}${separator}timestamp=${timestamp}&sign=${sign}`;

  const response = await axios.post(
    signedUrl,
    {
      msgtype: 'markdown',
      markdown: { title: '[新的消息]', text },
      at: { atMobiles: [], atUserIds: [], isAtAll: false },
    },
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );

  if (response.data?.errcode !== 0) {
    throw new Error(`DingTalk send failed: ${response.data?.errmsg ?? 'unknown error'}`);
  }
}

type InboundTextParseResult =
  | { text: string; source: 'text' | 'richText' }
  | { text: ''; reason: 'unsupported' | 'empty' };

function resolveDingTalkAccessToken(): string {
  const token = process.env.DINGTALK_ACCESS_TOKEN ?? process.env.DINGTALK_APP_ACCESS_TOKEN;
  return typeof token === 'string' ? token.trim() : '';
}

async function resolveMessageFileDownloadUrl(params: {
  downloadCode: string;
  robotCode: string;
  accessToken: string;
}): Promise<string> {
  const response = await axios.post<{ downloadUrl?: string }>(
    'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
    {
      downloadCode: params.downloadCode,
      robotCode: params.robotCode,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': params.accessToken,
      },
    },
  );

  return (response.data?.downloadUrl ?? '').trim();
}

async function parseRichTextNodes(params: {
  nodes?: DingTalkRichTextNode[];
  robotCode?: string;
  log: (message: string) => void;
  accountId: string;
}): Promise<string> {
  const { nodes, robotCode, log, accountId } = params;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return '';
  }

  const accessToken = resolveDingTalkAccessToken();
  const resolvedRobotCode = typeof robotCode === 'string' ? robotCode.trim() : '';
  const parts: string[] = [];

  for (const node of nodes) {
    if (typeof node.text === 'string') {
      parts.push(node.text);
      continue;
    }

    if (node.type !== 'picture') {
      continue;
    }

    const downloadCode =
      typeof node.downloadCode === 'string'
        ? node.downloadCode
        : typeof node.pictureDownloadCode === 'string'
          ? node.pictureDownloadCode
          : '';

    if (!downloadCode) {
      parts.push('[图片]');
      continue;
    }

    if (!accessToken || !resolvedRobotCode || resolvedRobotCode === 'normal') {
      parts.push(`[图片 downloadCode=${downloadCode}]`);
      continue;
    }

    try {
      const downloadUrl = await resolveMessageFileDownloadUrl({
        downloadCode,
        robotCode: resolvedRobotCode,
        accessToken,
      });
      parts.push(downloadUrl ? `[图片](${downloadUrl})` : `[图片 downloadCode=${downloadCode}]`);
    } catch (err) {
      log(
        `dingtalk[${accountId}] resolve downloadUrl failed: ${String(err)}; fallback to downloadCode`,
      );
      parts.push(`[图片 downloadCode=${downloadCode}]`);
    }
  }

  return parts.join('');
}

async function parseInboundText(params: {
  payload: DingTalkInboundMessage;
  log: (message: string) => void;
  accountId: string;
}): Promise<InboundTextParseResult> {
  const { payload, log, accountId } = params;
  if (payload.msgtype === 'text') {
    const text = (payload.text?.content ?? '').trim();
    return text ? { text, source: 'text' } : { text: '', reason: 'empty' };
  }

  if (payload.msgtype === 'richText') {
    const text = (
      await parseRichTextNodes({
        nodes: payload.content?.richText,
        robotCode: payload.robotCode,
        log,
        accountId,
      })
    ).trim();
    return text ? { text, source: 'richText' } : { text: '', reason: 'empty' };
  }

  return { text: '', reason: 'unsupported' };
}

async function handleInboundMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  payload: DingTalkInboundMessage;
  log: (message: string) => void;
  error: (message: string) => void;
}): Promise<void> {
  const { cfg, account, payload, log, error } = params;
  const runtime = getRuntime();
  const isGroup = payload.conversationType === '2';

  const parsed = await parseInboundText({
    payload,
    log,
    accountId: account.accountId,
  });
  if ('reason' in parsed) {
    if (parsed.reason === 'unsupported') {
      log(`dingtalk[${account.accountId}] ignore unsupported msgtype=${payload.msgtype}`);
      return;
    }
    log(`dingtalk[${account.accountId}] ignore empty text`);
    return;
  }
  const messageText = parsed.text;

  webhookByConversation.set(payload.conversationId, {
    url: payload.sessionWebhook,
    expiresAt: payload.sessionWebhookExpiredTime,
  });

  const mentioned =
    !isGroup ||
    payload.isInAtList ||
    Boolean(payload.atUsers?.some((item) => item.dingtalkId === payload.chatbotUserId));

  if (isGroup && !mentioned) {
    log(`dingtalk[${account.accountId}] ignore non-mention group message`);
    return;
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? 'group' : 'direct',
      id: isGroup ? payload.conversationId : payload.senderId,
    },
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: 'DingTalk',
    from: isGroup ? `${payload.conversationId}:${payload.senderId}` : payload.senderId,
    timestamp: new Date(payload.createAt || Date.now()),
    envelope: envelopeOptions,
    body: `${payload.senderNick}: ${messageText}`,
  });

  const from = `dingtalk:${payload.senderId}`;
  const to = isGroup ? `chat:${payload.conversationId}` : `user:${payload.senderId}`;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: messageText,
    CommandBody: messageText,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? 'group' : 'direct',
    GroupSubject: isGroup ? payload.conversationTitle || payload.conversationId : undefined,
    SenderName: payload.senderNick,
    SenderId: payload.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: payload.msgId,
    Timestamp: Date.now(),
    WasMentioned: mentioned,
    CommandAuthorized: true,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: to,
  });

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const textChunkLimit = runtime.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = runtime.channel.text.resolveChunkMode(cfg, CHANNEL_ID);

  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (reply: ReplyPayload) => {
        const text = (reply.text ?? '').trim();
        if (!text) {
          return;
        }

        const chunks = runtime.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await sendMarkdownBySessionWebhook({
            sessionWebhook: payload.sessionWebhook,
            secretKey: account.secretKey,
            text: chunk,
          });
        }
      },
      onError: (err: unknown, info: { kind?: string }) => {
        error(`dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(err)}`);
      },
    });

  try {
    await runtime.channel.reply.dispatchReplyFromConfig({
      cfg,
      ctx: ctxPayload,
      dispatcher,
      replyOptions,
    });
    log(`dingtalk[${account.accountId}] dispatched message session=${route.sessionKey}`);
  } finally {
    markDispatchIdle();
  }
}

function createWebhookHandler(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  log: (message: string) => void;
  error: (message: string) => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      respondJson(res, 405, { errcode: 1, errmsg: 'Method Not Allowed' });
      return;
    }

    const token = readTokenHeader(req);
    if (!token || !params.account.secretKey.startsWith(token)) {
      respondJson(res, 401, { errcode: 1, errmsg: '[dingtalk] invalid token' });
      return;
    }

    try {
      const body = (await readJsonBody(req)) as DingTalkInboundMessage;
      await handleInboundMessage({
        cfg: params.cfg,
        account: params.account,
        payload: body,
        log: params.log,
        error: params.error,
      });
      respondJson(res, 200, { errcode: 0, errmsg: 'ok' });
    } catch (err) {
      params.error(`dingtalk[${params.account.accountId}] inbound error: ${String(err)}`);
      respondJson(res, 500, { errcode: 1, errmsg: 'internal error' });
    }
  };
}

export const dingtalkPlugin: ChannelPlugin = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: {
    configPrefixes: ['channels.dingtalk'],
  },
  configSchema: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        secretKey: { type: 'string' },
      },
      required: ['secretKey'],
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveDingTalkAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: ResolvedDingTalkAccount) => Boolean(account.secretKey),
    describeAccount: (account: ResolvedDingTalkAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.secretKey),
    }),
  },
  outbound: {
    deliveryMode: 'direct',
    chunker: null,
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
    }) => {
      const account = resolveDingTalkAccount(cfg, accountId);
      const cache = webhookByConversation.get(to);
      if (!cache) {
        throw new Error(`No sessionWebhook cache found for conversationId=${to}`);
      }
      if (cache.expiresAt <= Date.now()) {
        webhookByConversation.delete(to);
        throw new Error(`sessionWebhook expired for conversationId=${to}`);
      }

      await sendMarkdownBySessionWebhook({
        sessionWebhook: cache.url,
        secretKey: account.secretKey,
        text,
      });

      return {
        channel: CHANNEL_ID,
        to,
        messageId: `dingtalk-${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      log?: {
        info?: (message: string) => void;
        error?: (message: string) => void;
      };
    }) => {
      const account = resolveDingTalkAccount(ctx.cfg, ctx.accountId);
      if (!account.secretKey) {
        throw new Error('channels.dingtalk.secretKey is required');
      }

      const unregister = registerPluginHttpRoute({
        path: WEBHOOK_PATH,
        handler: createWebhookHandler({
          cfg: ctx.cfg,
          account,
          log: (message) => ctx.log?.info?.(message),
          error: (message) => ctx.log?.error?.(message),
        }),
        pluginId: CHANNEL_ID,
        source: 'channel',
        accountId: account.accountId,
        log: (message: string) => ctx.log?.info?.(message),
      });

      routeUnregisterByAccount.set(account.accountId, unregister);
      ctx.log?.info?.(`dingtalk[${account.accountId}] webhook route registered: ${WEBHOOK_PATH}`);
    },
    stopAccount: async (ctx: { accountId: string; log?: { info?: (message: string) => void } }) => {
      const unregister = routeUnregisterByAccount.get(ctx.accountId);
      if (unregister) {
        unregister();
        routeUnregisterByAccount.delete(ctx.accountId);
      }
      ctx.log?.info?.(`dingtalk[${ctx.accountId}] stopped`);
    },
  },
};
