import { describe, expect, it } from 'vitest';
import {
  applyNodeFlag,
  grantRevocationScope,
  nodeAuditAction,
  nodeFlagLabel,
  nodeFlagScope,
  nodeInSubscriptionContent,
  nodeStateAction,
  nodeStateFlagsOf,
  nodeVisibleToUsers,
} from '../packages/shared/src/admin-nodes';

describe('nodeStateFlagsOf', () => {
  it('預設三個旗標皆為 false', () => {
    expect(nodeStateFlagsOf({})).toEqual({ distributionStopped: false, hidden: false, serviceStopped: false });
  });
  it('讀取已設定的旗標', () => {
    expect(nodeStateFlagsOf({ distributionStopped: true, hidden: true })).toEqual({
      distributionStopped: true,
      hidden: true,
      serviceStopped: false,
    });
  });
  it('非物件資料時回傳預設值', () => {
    expect(nodeStateFlagsOf(null)).toEqual({ distributionStopped: false, hidden: false, serviceStopped: false });
  });
});

describe('nodeFlagLabel / nodeFlagScope', () => {
  it('三種狀態各有獨立標籤', () => {
    expect(nodeFlagLabel('distributionStopped')).toBe('停止新訂閱與訂閱更新');
    expect(nodeFlagLabel('hidden')).toBe('隱藏節點');
    expect(nodeFlagLabel('serviceStopped')).toBe('停止節點服務');
  });
  it('三種狀態的影響範圍說明互不相同且皆說明不刪除既有配置', () => {
    const distribution = nodeFlagScope('distributionStopped');
    const hidden = nodeFlagScope('hidden');
    const service = nodeFlagScope('serviceStopped');
    expect(distribution).not.toBe(hidden);
    expect(hidden).not.toBe(service);
    expect(service).not.toBe(distribution);
    expect(distribution).toContain('不再出現在新訂閱與訂閱更新中');
    expect(distribution).toContain('不會被主動刪除');
    expect(hidden).toContain('不再出現在使用者節點列表');
    expect(service).toContain('不會刪除節點憑據');
  });
});

describe('nodeStateAction', () => {
  it('三種狀態的切換動作皆獨立', () => {
    expect(nodeStateAction('distributionStopped', true)).toBe('停止分發');
    expect(nodeStateAction('distributionStopped', false)).toBe('恢復分發');
    expect(nodeStateAction('hidden', true)).toBe('隱藏');
    expect(nodeStateAction('hidden', false)).toBe('取消隱藏');
    expect(nodeStateAction('serviceStopped', true)).toBe('停止服務');
    expect(nodeStateAction('serviceStopped', false)).toBe('恢復服務');
  });
});

describe('nodeAuditAction', () => {
  it('停止與恢復各有專屬審計動作', () => {
    expect(nodeAuditAction('distributionStopped', true)).toBe('node.distribution.stopped');
    expect(nodeAuditAction('distributionStopped', false)).toBe('node.distribution.resumed');
    expect(nodeAuditAction('hidden', true)).toBe('node.hidden');
    expect(nodeAuditAction('hidden', false)).toBe('node.shown');
    expect(nodeAuditAction('serviceStopped', true)).toBe('node.service.stopped');
    expect(nodeAuditAction('serviceStopped', false)).toBe('node.service.resumed');
  });
});

describe('nodeVisibleToUsers', () => {
  it('停止分發的節點仍在使用者節點列表顯示', () => {
    expect(nodeVisibleToUsers({ distributionStopped: true, hidden: false, serviceStopped: false })).toBe(true);
  });
  it('隱藏或停止服務的節點不在使用者節點列表顯示', () => {
    expect(nodeVisibleToUsers({ distributionStopped: false, hidden: true, serviceStopped: false })).toBe(false);
    expect(nodeVisibleToUsers({ distributionStopped: false, hidden: false, serviceStopped: true })).toBe(false);
  });
});

describe('nodeInSubscriptionContent', () => {
  it('三種狀態皆排除於訂閱內容之外', () => {
    expect(nodeInSubscriptionContent({ distributionStopped: true, hidden: false, serviceStopped: false })).toBe(false);
    expect(nodeInSubscriptionContent({ distributionStopped: false, hidden: true, serviceStopped: false })).toBe(false);
    expect(nodeInSubscriptionContent({ distributionStopped: false, hidden: false, serviceStopped: true })).toBe(false);
  });
  it('無任何旗標時保留於訂閱內容', () => {
    expect(nodeInSubscriptionContent({ distributionStopped: false, hidden: false, serviceStopped: false })).toBe(true);
  });
});

describe('applyNodeFlag', () => {
  it('只變更指定旗標，其餘旗標不變', () => {
    const next = applyNodeFlag({ distributionStopped: true, hidden: false, serviceStopped: false }, 'hidden', true);
    expect(next).toEqual({ distributionStopped: true, hidden: true, serviceStopped: false });
  });
});

describe('grantRevocationScope', () => {
  it('撤銷授權的影響範圍說明不含斷開既有連接或刪除配置', () => {
    const scope = grantRevocationScope();
    expect(scope).toContain('不再能用於取得或更新訂閱配置');
    expect(scope).toContain('不會斷開已有客戶端連接');
    expect(scope).toContain('不刪除客戶端配置');
    expect(scope).toContain('不刪除節點憑據');
    expect(scope).toContain('不停止節點服務');
  });
});
