export type NodeAdminFlag = 'distributionStopped' | 'hidden' | 'serviceStopped';

export interface NodeStateFlags {
  distributionStopped: boolean;
  hidden: boolean;
  serviceStopped: boolean;
}

export const NODE_STATE_FIELDS: readonly NodeAdminFlag[] = [
  'distributionStopped',
  'hidden',
  'serviceStopped',
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(value) === false
  );
}

export function nodeStateFlagsOf(data: unknown): NodeStateFlags {
  const record = isRecord(data) ? data : {};
  return {
    distributionStopped: record.distributionStopped === true,
    hidden: record.hidden === true,
    serviceStopped: record.serviceStopped === true,
  };
}

export function nodeFlagLabel(flag: NodeAdminFlag): string {
  if (flag === 'distributionStopped') return '停止新訂閱與訂閱更新';
  if (flag === 'hidden') return '隱藏節點';
  return '停止節點服務';
}

export function nodeFlagScope(flag: NodeAdminFlag): string {
  if (flag === 'distributionStopped') {
    return '自此之後，該節點不再出現在新訂閱與訂閱更新中；已匯入的客戶端配置不會被主動刪除，節點服務不受影響。';
  }
  if (flag === 'hidden') {
    return '該節點將不再出現在使用者節點列表與新訂閱內容中；已匯入的客戶端配置不會被主動刪除，節點服務不受影響。';
  }
  return '該節點的服務將被標記為已停止，不再出現在使用者節點列表與訂閱內容中；此操作不會刪除節點憑據，也不會刪除已匯入的客戶端配置。';
}

export function nodeStateAction(flag: NodeAdminFlag, value: boolean): string {
  if (value === false) {
    if (flag === 'distributionStopped') return '恢復分發';
    if (flag === 'hidden') return '取消隱藏';
    return '恢復服務';
  }
  if (flag === 'distributionStopped') return '停止分發';
  if (flag === 'hidden') return '隱藏';
  return '停止服務';
}

export function nodeAuditAction(flag: NodeAdminFlag, value: boolean): string {
  if (flag === 'distributionStopped')
    return value ? 'node.distribution.stopped' : 'node.distribution.resumed';
  if (flag === 'hidden') return value ? 'node.hidden' : 'node.shown';
  return value ? 'node.service.stopped' : 'node.service.resumed';
}

export function nodeVisibleToUsers(flags: NodeStateFlags): boolean {
  return flags.hidden === false && flags.serviceStopped === false;
}

export function nodeInSubscriptionContent(flags: NodeStateFlags): boolean {
  return (
    flags.distributionStopped === false &&
    flags.hidden === false &&
    flags.serviceStopped === false
  );
}

export function applyNodeFlag(
  current: NodeStateFlags,
  flag: NodeAdminFlag,
  value: boolean,
): NodeStateFlags {
  return { ...current, [flag]: value };
}

export function grantRevocationScope(): string {
  return '撤銷後，此授權不再能用於取得或更新訂閱配置；不會斷開已有客戶端連接、不刪除客戶端配置、不刪除節點憑據、不停止節點服務。';
}
