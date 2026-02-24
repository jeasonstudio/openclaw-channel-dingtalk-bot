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

const DEFAULT_WEBHOOK_PATH = '/dingtalk-channel/message';
const CHANNEL_ID = 'dingtalk';
const DEFAULT_OUTBOUND_TITLE = '[新的消息]';
const OUTBOUND_TITLE_PREVIEW_LENGTH = 15;

const webhookByConversation = new Map<string, { url: string; expiresAt: number }>();
const routeUnregisterByAccount = new Map<string, () => void>();

interface DingTalkMentionPayload {
  atUserIds: string[];
}

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
    webhookPath: typeof channelCfg?.webhookPath === 'string' ? channelCfg.webhookPath.trim() : '',
  };
}

function resolveWebhookPath(cfg: OpenClawConfig): string {
  const rawPath = resolveDingTalkConfig(cfg).webhookPath?.trim() ?? '';
  if (!rawPath) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
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

function stripMarkdownToPlainText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|[0-9]+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOutboundTitle(text: string): string {
  const plainText = stripMarkdownToPlainText(text);
  if (!plainText) {
    return DEFAULT_OUTBOUND_TITLE;
  }

  return Array.from(plainText).slice(0, OUTBOUND_TITLE_PREVIEW_LENGTH).join('');
}

async function sendMarkdownBySessionWebhook(params: {
  sessionWebhook: string;
  secretKey: string;
  text: string;
  mention?: DingTalkMentionPayload;
}): Promise<void> {
  const { sessionWebhook, secretKey, text, mention } = params;
  const { timestamp, sign } = dingtalkSign(secretKey);
  const separator = sessionWebhook.includes('?') ? '&' : '?';
  const signedUrl = `${sessionWebhook}${separator}timestamp=${timestamp}&sign=${sign}`;
  const atUserIds = Array.from(
    new Set(
      (mention?.atUserIds ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  const title = buildOutboundTitle(text);

  const response = await axios.post(
    signedUrl,
    {
      msgtype: 'markdown',
      markdown: { title, text },
      at: { atMobiles: [], atUserIds, isAtAll: false },
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
  | { text: string; source: 'text' | 'richText'; richTextImages: RichTextImageTask[] }
  | { text: ''; reason: 'unsupported' | 'empty' };

interface RichTextImageTask {
  downloadCode: string;
  placeholder: string;
}

interface RichTextParseResult {
  text: string;
  images: RichTextImageTask[];
}

interface InboundSavedMedia {
  path: string;
  contentType: string;
  placeholder: string;
}

const MAX_RICHTEXT_IMAGES = 10;
const RICHTEXT_IMAGE_PLACEHOLDER = '<media:image>';
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 30 * 1024 * 1024;

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

function resolveHttpContentType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const headerValue =
    (headers as Record<string, unknown>)['content-type'] ??
    (headers as Record<string, unknown>)['Content-Type'];
  return typeof headerValue === 'string' ? headerValue.trim() : '';
}

async function resolveBufferContentType(params: {
  runtime: any;
  buffer: Buffer;
  fallback: string;
  log: (message: string) => void;
  accountId: string;
}): Promise<string> {
  const { runtime, buffer, fallback, log, accountId } = params;
  try {
    const detectByCore = runtime?.core?.media?.detectMime;
    if (typeof detectByCore === 'function') {
      const maybeMime = await detectByCore({ buffer });
      if (typeof maybeMime === 'string' && maybeMime.trim()) {
        return maybeMime.trim();
      }
    }
  } catch (err) {
    log(`dingtalk[${accountId}] detect mime by core failed: ${String(err)}`);
  }

  try {
    const detectByChannel = runtime?.channel?.media?.detectMime;
    if (typeof detectByChannel === 'function') {
      const maybeMime = await detectByChannel({ buffer });
      if (typeof maybeMime === 'string' && maybeMime.trim()) {
        return maybeMime.trim();
      }
    }
  } catch (err) {
    log(`dingtalk[${accountId}] detect mime by channel failed: ${String(err)}`);
  }

  return fallback || 'application/octet-stream';
}

async function downloadAndSaveRichTextImages(params: {
  runtime: any;
  accountId: string;
  robotCode?: string;
  images: RichTextImageTask[];
  log: (message: string) => void;
}): Promise<InboundSavedMedia[]> {
  const { runtime, accountId, robotCode, images, log } = params;
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const saveMediaBuffer = runtime?.channel?.media?.saveMediaBuffer;
  if (typeof saveMediaBuffer !== 'function') {
    log(`dingtalk[${accountId}] runtime.channel.media.saveMediaBuffer unavailable, skip media`);
    return [];
  }

  const accessToken = resolveDingTalkAccessToken();
  const resolvedRobotCode = typeof robotCode === 'string' ? robotCode.trim() : '';
  if (!accessToken || !resolvedRobotCode || resolvedRobotCode === 'normal') {
    return [];
  }

  const out: InboundSavedMedia[] = [];
  for (const image of images) {
    try {
      const downloadUrl = await resolveMessageFileDownloadUrl({
        downloadCode: image.downloadCode,
        robotCode: resolvedRobotCode,
        accessToken,
      });
      if (!downloadUrl) {
        log(`dingtalk[${accountId}] empty downloadUrl for richText image`);
        continue;
      }

      const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const contentType = await resolveBufferContentType({
        runtime,
        buffer,
        fallback: resolveHttpContentType(response.headers),
        log,
        accountId,
      });
      const saved = await saveMediaBuffer(
        buffer,
        contentType,
        'inbound',
        DEFAULT_INBOUND_MEDIA_MAX_BYTES,
      );
      if (!saved?.path) {
        log(`dingtalk[${accountId}] saveMediaBuffer returned empty path`);
        continue;
      }
      out.push({
        path: saved.path,
        contentType: typeof saved.contentType === 'string' ? saved.contentType : contentType,
        placeholder: image.placeholder,
      });
    } catch (err) {
      log(`dingtalk[${accountId}] richText image download/save failed: ${String(err)}`);
    }
  }

  return out;
}

function parseRichTextNodes(params: {
  nodes?: DingTalkRichTextNode[];
}): RichTextParseResult {
  const { nodes } = params;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { text: '', images: [] };
  }

  const parts: string[] = [];
  const images: RichTextImageTask[] = [];

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

    if (!downloadCode || images.length >= MAX_RICHTEXT_IMAGES) {
      parts.push('[图片]');
      continue;
    }

    parts.push(RICHTEXT_IMAGE_PLACEHOLDER);
    images.push({
      downloadCode,
      placeholder: RICHTEXT_IMAGE_PLACEHOLDER,
    });
  }

  return { text: parts.join(''), images };
}

async function parseInboundText(params: {
  payload: DingTalkInboundMessage;
}): Promise<InboundTextParseResult> {
  const { payload } = params;
  if (payload.msgtype === 'text') {
    const text = (payload.text?.content ?? '').trim();
    return text ? { text, source: 'text', richTextImages: [] } : { text: '', reason: 'empty' };
  }

  if (payload.msgtype === 'richText') {
    const parsedRichText = parseRichTextNodes({
      nodes: payload.content?.richText,
    });
    const text = parsedRichText.text.trim();
    return text
      ? { text, source: 'richText', richTextImages: parsedRichText.images }
      : { text: '', reason: 'empty' };
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
  const savedMedia =
    parsed.source === 'richText'
      ? await downloadAndSaveRichTextImages({
          runtime,
          accountId: account.accountId,
          robotCode: payload.robotCode,
          images: parsed.richTextImages,
          log,
        })
      : [];
  const mediaPaths = savedMedia.map((item) => item.path).filter((item) => item.trim().length > 0);
  const mediaTypes = savedMedia
    .map((item) => item.contentType)
    .filter((item) => item.trim().length > 0);
  const mediaPayload: Record<string, unknown> = {};
  if (mediaPaths.length === 1) {
    mediaPayload.MediaPath = mediaPaths[0];
    if (mediaTypes[0]) {
      mediaPayload.MediaType = mediaTypes[0];
    }
  }
  if (mediaPaths.length > 1) {
    mediaPayload.MediaPaths = mediaPaths;
    if (mediaTypes.length === mediaPaths.length) {
      mediaPayload.MediaTypes = mediaTypes;
    }
  }
  const mentionCandidateIds = Array.from(
    new Set(
      (payload.atUsers ?? [])
        .map((item) => item.dingtalkId?.trim() ?? '')
        .filter((item) => item.length > 0),
    ),
  );

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
    ...mediaPayload,
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
            mention: mentionCandidateIds.length > 0 ? { atUserIds: mentionCandidateIds } : undefined,
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
    media: true,
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
        webhookPath: { type: 'string' },
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
      const webhookPath = resolveWebhookPath(ctx.cfg);
      if (!account.secretKey) {
        throw new Error('channels.dingtalk.secretKey is required');
      }

      const prevUnregister = routeUnregisterByAccount.get(account.accountId);
      if (prevUnregister) {
        prevUnregister();
        routeUnregisterByAccount.delete(account.accountId);
      }

      const unregister = registerPluginHttpRoute({
        path: webhookPath,
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
      ctx.log?.info?.(`dingtalk[${account.accountId}] webhook route registered: ${webhookPath}`);
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
