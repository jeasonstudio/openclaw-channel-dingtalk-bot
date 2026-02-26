export interface DingTalkConfig {
  enabled?: boolean;
  secretKey: string;
  webhookPath?: string;
  accessToken?: string;
  blockStreaming?: boolean;
  toolProgress?: 'off' | 'simple';
  toolProgressInGroup?: 'off' | 'simple';
}

export interface ResolvedDingTalkAccount {
  accountId: string;
  enabled: boolean;
  secretKey: string;
  accessToken: string;
  blockStreaming: boolean;
  toolProgress: 'off' | 'simple';
  toolProgressInGroup: 'off' | 'simple';
}

export interface DingTalkInboundMessage {
  msgtype: string;
  text?: { content: string };
  content?: {
    richText?: DingTalkRichTextNode[];
  };
  msgId: string;
  conversationType: string;
  conversationId: string;
  conversationTitle?: string;
  senderId: string;
  senderNick: string;
  senderPlatform?: string;
  chatbotUserId: string;
  openThreadId?: string;
  robotCode?: string;
  createAt: number;
  isAdmin: boolean;
  isInAtList: boolean;
  atUsers?: Array<{ dingtalkId: string }>;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
}

export interface DingTalkRichTextNode {
  text?: string;
  type?: string;
  downloadCode?: string;
  pictureDownloadCode?: string;
  fileName?: string;
  contentType?: string;
  width?: number;
  height?: number;
}
