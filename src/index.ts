import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/index.js';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
import { dingtalkPlugin } from './channel';
import { setRuntime } from './runtime';

const plugin = {
  id: 'dingtalk',
  name: 'DingTalk',
  description: 'DingTalk webhook channel plugin',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
export { dingtalkPlugin };
export * from './types';
