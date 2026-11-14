// 訂閱下載格式：查詢參數接受的值，與下載處理實際使用的匯出格式。
// `clash` 是 Mihomo/Clash YAML 格式的別名；`shadowrocket`（URI 列表）
// 與 `v2rayn`（base64 編碼連結）則對映到既有的匯出格式。
export const SUBSCRIPTION_DOWNLOAD_FORMATS = [
  'mihomo',
  'sing-box',
  'uri',
  'base64',
  'shadowrocket',
  'v2rayn',
  'clash',
] as const;

export type SubscriptionDownloadFormat =
  (typeof SUBSCRIPTION_DOWNLOAD_FORMATS)[number];

export type SubscriptionExportFormat = 'mihomo' | 'sing-box' | 'uri' | 'base64';

export function normalizeSubscriptionFormat(
  format: SubscriptionDownloadFormat,
): SubscriptionExportFormat {
  if (format === 'clash') return 'mihomo';
  if (format === 'shadowrocket') return 'uri';
  if (format === 'v2rayn') return 'base64';
  return format;
}
