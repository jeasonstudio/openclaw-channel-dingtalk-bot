import type { PluginRuntime } from 'openclaw/dist/plugin-sdk/index.js';

let runtimeRef: PluginRuntime | null = null;

export function setRuntime(runtime: PluginRuntime): void {
  runtimeRef = runtime;
}

export function getRuntime(): PluginRuntime {
  if (!runtimeRef) {
    throw new Error('DingTalk runtime is not initialized.');
  }
  return runtimeRef;
}
