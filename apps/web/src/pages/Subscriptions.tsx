import { SubscriptionWorkspace } from '../../../../packages/ui/src/subscriptions';
import { useApp } from '../../../../packages/ui/src/core';
import { NodeCatalog } from '../workspace/NodeCatalog';
export function Subscriptions() {
  const { session } = useApp();
  return session.user.role === 'Member' ? (
    <NodeCatalog />
  ) : (
    <SubscriptionWorkspace />
  );
}
