import { platformAiEnabled } from '../../shared/src/platform-ai';

// GPT-only 平台账号门控：Codex 已取消，平台账号只在 GPT 平台启用时可用。
export function platformAccountsEnabled(): boolean {
  return platformAiEnabled();
}

export { platformAiEnabled };
