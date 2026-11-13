import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  notificationKind,
  notificationTitle,
  toNotification,
} from '../packages/shared/src/notifications';
describe('stage-d notifications', () => {
  it('maps audit actions to kinds', () => {
    expect(notificationKind('subscription.rotated')).toBe('subscription');
    expect(notificationKind('session.revoked')).toBe('session');
    expect(notificationKind('source.imported')).toBe('source');
    expect(notificationKind('quota.changed')).toBe('quota');
    expect(notificationKind('something.else')).toBe('system');
  });
  it('gives Chinese titles for known actions and keeps unknown actions', () => {
    expect(notificationTitle('subscription.rotated')).toBe('订阅凭证已轮换');
    expect(notificationTitle('session.revoked')).toBe('会话已撤销');
    expect(notificationTitle('unknown.action')).toBe('unknown.action');
  });
  it('converts an audit row to a notification without leaking other owners data', () => {
    const item = toNotification({
      id: 'n1',
      action: 'subscription.revoked',
      target_id: 'tok-1',
      correlation_id: null,
      created_at: '2026-11-12T12:00:00.000Z',
    });
    expect(item.kind).toBe('subscription');
    expect(item.title).toBe('订阅凭证已撤销');
    expect(item.detail).toContain('tok-1');
    expect(item.createdAt).toBe('2026-11-12T12:00:00.000Z');
  });
  it('design system keeps the FAFA ONE 3.0 tokens', () => {
    const css = readFileSync('packages/ui/src/style.css', 'utf8');
    for (const token of ['#6d5ef9', '#f6f7fb', '#172033', '#dde4ef'])
      expect(css.toLowerCase()).toContain(token);
    expect(css).toContain("[data-theme='dark']");
  });
});
