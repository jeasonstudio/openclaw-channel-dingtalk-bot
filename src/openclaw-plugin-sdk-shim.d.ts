declare module 'openclaw/plugin-sdk' {
  export const DEFAULT_ACCOUNT_ID: string;
  export function emptyPluginConfigSchema(): unknown;
  export function createReplyPrefixContext(params: unknown): {
    responsePrefix?: string;
    responsePrefixContextProvider?: unknown;
  };
  export function registerPluginHttpRoute(params: unknown): () => void;
}

declare module 'openclaw/dist/plugin-sdk/index.js' {
  export type OpenClawPluginApi = any;
  export type PluginRuntime = any;
  export type ChannelMeta = any;
  export type ChannelPlugin = any;
  export type OpenClawConfig = any;
  export type ReplyPayload = any;
}
