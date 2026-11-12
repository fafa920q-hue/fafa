// Stage D: user notifications are the owner-scoped audit trail, no demo data.
export type NotificationKind = "subscription" | "session" | "source" | "quota" | "ai" | "account" | "system";
export interface AuditNotificationRow { id: string; action: string; target_id: string | null; correlation_id: string | null; created_at: string; }
export interface NotificationItem { id: string; action: string; kind: NotificationKind; title: string; detail: string; createdAt: string; }
export function notificationKind(action: string): NotificationKind {
  if (action.indexOf("subscription") === 0) return "subscription";
  if (action.indexOf("session") === 0) return "session";
  if (action.indexOf("source") === 0) return "source";
  if (action.indexOf("quota") === 0) return "quota";
  if (action.indexOf("platform-ai") === 0 || action.indexOf("ai.") === 0) return "ai";
  if (action.indexOf("member") === 0 || action.indexOf("profile") === 0 || action.indexOf("auth") === 0) return "account";
  return "system";
}
export function notificationTitle(action: string): string {
  const titles: Record<string, string> = {
    "subscription.rotated": "订阅凭证已轮换",
    "subscription.revoked": "订阅凭证已撤销",
    "session.revoked": "会话已撤销",
    "source.imported": "节点来源已导入",
    "source.updated": "节点来源已更新",
    "member.subscribed": "订阅已更新",
  };
  return titles[action] || action;
}
export function toNotification(row: AuditNotificationRow): NotificationItem {
  return { id: row.id, action: row.action, kind: notificationKind(row.action), title: notificationTitle(row.action), detail: row.target_id ? "对象：" + row.target_id : "", createdAt: row.created_at };
}

