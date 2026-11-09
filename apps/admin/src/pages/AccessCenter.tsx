import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Card,
  DataState,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

type Resource = { id: string; name: string };
type NodeScope = { nodeIds: string[]; groups: string[] };
type Resources = {
  sources: Resource[];
  servers: Resource[];
  groups: string[];
  nodes: (Resource & { sourceId: string; group: string })[];
};
type Grant = {
  id: string;
  data: { endsAt?: string; expiresAt?: string; nodeScope?: NodeScope };
};
type AccessUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: boolean;
  base: Record<string, any>;
  effective: Record<string, boolean>;
  policy: Record<string, any>;
  overlays: { kind: string; name?: string; endsAt: string }[];
  traffic: {
    bytes: number | null;
    limitBytes: number | null;
    enforcement: string;
  };
  aiQuota: { dailyLimit: number; concurrency: number };
  grants: { sources: Grant[]; servers: Grant[] };
};
const capabilities = { node: '节点', server: '服务器与 SSH', codex: 'AI 任务' };
const entries = Object.entries(capabilities);
const nullable = (data: FormData, name: string) =>
  String(data.get(name) || '').trim() || null;
const selected = (data: FormData, name: string) =>
  data.getAll(name).map(String);
const time = (value?: string) =>
  value ? new Date(value).toLocaleString('zh-CN') : '长期';

export function Toggle({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type="checkbox" defaultChecked={checked} />
    </label>
  );
}
export function Field({
  name,
  label,
  value,
  min,
  max,
  required,
  step,
}: {
  name: string;
  label: string;
  value?: string | number | null;
  min?: number;
  max?: number;
  required?: boolean;
  step?: number;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        name={name}
        defaultValue={value ?? ''}
        type={min === undefined ? 'text' : 'number'}
        min={min}
        max={max}
        step={step}
        required={required}
      />
    </label>
  );
}
export function Options({
  name,
  label,
  items,
  values,
  multiple = false,
}: {
  name: string;
  label: string;
  items: Resource[];
  values?: string[];
  multiple?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        name={name}
        multiple={multiple}
        defaultValue={multiple ? (values ?? []) : (values?.[0] ?? '')}
      >
        {!multiple && <option value="">请选择</option>}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.id}
          </option>
        ))}
      </select>
    </label>
  );
}
function AccessForm({
  user,
  resources,
  save,
}: {
  user: AccessUser;
  resources: Resources;
  save: (path: string, method: string, patch: object) => Promise<void>;
}) {
  const url = '/api/admin/access/users/' + user.id;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const limit = nullable(data, 'traffic');
    const changes = Object.fromEntries(
      entries.flatMap(([kind]) => {
        const enabled = data.has(kind),
          until = nullable(data, kind + 'Until');
        return enabled === user.base[kind] &&
          until === (user.base[kind + 'Until'] || null)
          ? []
          : [[kind, { enabled, until }]];
      }),
    );
    const nodeLimit = Number(data.get('nodeLimit'));
    const dailyLimit = Number(data.get('dailyLimit')),
      concurrency = Number(data.get('concurrency'));
    void save(url, 'PATCH', {
      ...changes,
      ...(data.has('disabled') !== user.disabled
        ? { disabled: data.has('disabled') }
        : {}),
      ...(data.has('subscription') !== user.base.subscriptionEnabled
        ? { subscriptionEnabled: data.has('subscription') }
        : {}),
      ...(nodeLimit !== user.base.nodeLimit ? { nodeLimit } : {}),
      trafficLimitBytes: limit === null ? null : Number(limit),
      policy: {
        catalogEnabled: data.has('catalog'),
        subscriptionUntil: nullable(data, 'subscriptionUntil'),
        aiUntil: nullable(data, 'aiUntil'),
        aiServiceEnabled: data.has('aiService'),
        groups: data.has('limitGroups') ? selected(data, 'groups') : null,
        trafficPeriodStart: String(data.get('trafficPeriodStart')),
      },
      ...(dailyLimit !== user.aiQuota.dailyLimit ||
      concurrency !== user.aiQuota.concurrency
        ? { aiQuota: { dailyLimit, concurrency } }
        : {}),
    });
  };
  return (
    <>
      <p>
        当前授权{' '}
        {entries
          .filter(([kind]) => user.effective[kind])
          .map(([, label]) => label)
          .join('、') || '无'}
      </p>
      {user.overlays.map((activity) => (
        <p key={activity.kind}>
          {activity.name ||
            (activity.kind === 'TRIAL' ? '注册体验' : '全站开放')}{' '}
          · {time(activity.endsAt)}
        </p>
      ))}
      <form className="fields" onSubmit={submit}>
        <Toggle
          name="disabled"
          label="停用账户并撤销会话"
          checked={user.disabled}
        />
        <Toggle
          name="catalog"
          label="允许查看公开节点"
          checked={user.policy.catalogEnabled}
        />
        {entries.map(([kind, label]) => (
          <fieldset key={kind}>
            <Toggle
              name={kind}
              label={'基础权限 · ' + label}
              checked={user.base[kind]}
            />
            <Field
              name={kind + 'Until'}
              label="基础权限到期（UTC ISO，可留空）"
              value={user.base[kind + 'Until']}
            />
          </fieldset>
        ))}
        <Toggle
          name="subscription"
          label="允许个人订阅"
          checked={user.base.subscriptionEnabled}
        />
        <Field
          name="subscriptionUntil"
          label="订阅到期（UTC ISO，可留空）"
          value={user.policy.subscriptionUntil}
        />
        <Field
          name="nodeLimit"
          label="节点数量上限"
          min={0}
          max={5000}
          value={user.base.nodeLimit}
          required
        />
        <Toggle
          name="limitGroups"
          label="限定可订阅节点分组"
          checked={user.policy.groups !== null}
        />
        <Options
          name="groups"
          label="分组"
          items={resources.groups.map((group) => ({ id: group, name: group }))}
          values={user.policy.groups || []}
          multiple
        />
        <Field
          name="traffic"
          label="流量上限（字节，留空表示不限）"
          min={0}
          max={Number.MAX_SAFE_INTEGER}
          value={user.base.trafficLimitBytes}
        />
        <Field
          name="trafficPeriodStart"
          label="计量周期开始（UTC ISO）"
          value={user.policy.trafficPeriodStart}
          required
        />
        <p>
          已登记用量{' '}
          {user.traffic.bytes === null
            ? '暂无计量'
            : user.traffic.bytes.toLocaleString() + ' 字节'}
          。有限额且缺少计量时，系统会拒绝获取订阅。
        </p>
        <Toggle
          name="aiService"
          label="允许使用管理员提供的 AI 服务"
          checked={user.policy.aiServiceEnabled}
        />
        <Field
          name="aiUntil"
          label="AI 服务到期（UTC ISO，可留空）"
          value={user.policy.aiUntil}
        />
        <Field
          name="dailyLimit"
          label="AI 近 24 小时调用上限"
          min={0}
          max={1000}
          value={user.aiQuota.dailyLimit}
          required
        />
        <Field
          name="concurrency"
          label="AI 并发上限"
          min={1}
          max={10}
          value={user.aiQuota.concurrency}
          required
        />
        <button>保存用户权限</button>
      </form>
    </>
  );
}

const bulkActions: Record<string, { label: string; patch: object }> = {
  disable: { label: '停用账户', patch: { disabled: true } },
  restore: { label: '恢复账户', patch: { disabled: false } },
  revokeLinks: {
    label: '撤销旧订阅链接',
    patch: { revokeSubscriptions: true },
  },
  allowNodes: { label: '开放节点基础权限', patch: { node: { enabled: true } } },
  denyNodes: {
    label: '禁止节点及活动授权',
    patch: { node: { enabled: false } },
  },
  allowServers: {
    label: '开放服务器基础权限',
    patch: { server: { enabled: true } },
  },
  denyServers: {
    label: '禁止服务器及活动授权',
    patch: { server: { enabled: false } },
  },
  allowAi: { label: '开放 AI 基础权限', patch: { codex: { enabled: true } } },
  denyAi: { label: '禁止 AI 及活动授权', patch: { codex: { enabled: false } } },
  denySubscription: {
    label: '禁止订阅',
    patch: { subscriptionEnabled: false },
  },
  allowSubscription: {
    label: '允许订阅',
    patch: { subscriptionEnabled: true },
  },
  revokeTrial: { label: '撤销注册体验', patch: { revokeTrial: true } },
  revokeSessions: { label: '撤销登录会话', patch: { revokeSessions: true } },
};

export function AccessCenter() {
  const { request, toast } = useApp();
  const users = useData<AccessUser[]>('/api/admin/access/users');
  const resources = useData<Resources>('/api/admin/access/resources');
  const audit = useData<
    { id: string; name: string; action: string; created_at: string }[]
  >('/api/admin/access/audit');
  const [userId, selectUser] = useState('');
  const [busy, setBusy] = useState(false);
  const members = users.data?.filter((user) => user.role === 'Member') ?? [];
  const user = members.find((member) => member.id === userId);
  const options = members.map((member) => ({
    id: member.id,
    name: member.name + ' · ' + member.email,
  }));
  const save = async (path: string, method: string, patch: object) => {
    if (busy) return;
    setBusy(true);
    try {
      await request(path, method, patch);
      users.refresh();
      audit.refresh();
      toast('权限已保存并记录审计');
    } catch {
      // The shared request handler displays API errors.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="用户权限中心"
      description="普通账户、节点订阅、SSH、AI 和临时资格。管理员及 Owner 受角色保护。"
    >
      <DataState
        error={users.error || resources.error}
        loading={!users.data || !resources.data}
        onRetry={() => {
          users.refresh();
          resources.refresh();
        }}
      />
      {users.data && resources.data && (
        <fieldset disabled={busy}>
          <label>
            <span>选择普通用户</span>
            <select
              value={userId}
              onChange={(event) => selectUser(event.target.value)}
            >
              <option value="">选择用户</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          {user && (
            <AccessForm
              key={JSON.stringify(user)}
              user={user}
              resources={resources.data}
              save={save}
            />
          )}
          {user && (
            <GrantForms
              key={user.id}
              user={user}
              resources={resources.data}
              save={save}
            />
          )}
          <details>
            <summary>批量授权与撤销</summary>
            <form
              className="fields"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget),
                  ids = selected(data, 'users');
                const action = bulkActions[String(data.get('action'))];
                if (!ids.length || !action) {
                  toast('请先选择用户和操作');
                  return;
                }
                if (
                  !window.confirm(
                    action.label + ' · ' + ids.length + ' 个账户，确认执行？',
                  )
                )
                  return;
                void save('/api/admin/access/bulk', 'POST', {
                  userIds: ids,
                  patch: action.patch,
                });
              }}
            >
              <Options
                name="users"
                label="选择普通用户（最多 100 人）"
                items={options}
                multiple
              />
              <Options
                name="action"
                label="批量操作"
                items={Object.entries(bulkActions).map(([id, action]) => ({
                  id,
                  name: action.label,
                }))}
              />
              <button>执行批量操作</button>
            </form>
          </details>
        </fieldset>
      )}
      <details>
        <summary>权限变更日志</summary>
        <DataState
          error={audit.error}
          loading={!audit.data}
          onRetry={audit.refresh}
        />
        {audit.data?.slice(0, 30).map((event) => (
          <div className="list-item" key={event.id}>
            <strong>{event.action}</strong>
            <small>
              {event.name || '系统'} · {time(event.created_at)}
            </small>
          </div>
        ))}
        {audit.data?.length === 0 && <p>暂无权限变更</p>}
      </details>
    </Card>
  );
}

function GrantForms({
  user,
  resources,
  save,
}: {
  user: AccessUser;
  resources: Resources;
  save: (path: string, method: string, patch: object) => Promise<void>;
}) {
  const path = '/api/admin/access/users/' + user.id;
  const { toast } = useApp();
  const [sourceId, setSourceId] = useState('');
  const sourceGrant = user.grants.sources.find(
    (grant) => grant.id === sourceId,
  );
  const sourceNodes = resources.nodes.filter(
    (node) => node.sourceId === sourceId,
  );
  const sourceGroups = [
    ...new Set(sourceNodes.map((node) => node.group).filter(Boolean)),
  ];
  return (
    <>
      {(['source', 'server'] as const).map((kind) => {
        const items = kind === 'source' ? resources.sources : resources.servers;
        const grants =
          kind === 'source' ? user.grants.sources : user.grants.servers;
        return (
          <details key={kind}>
            <summary>
              {kind === 'source' ? '节点分配' : '服务器及 SSH 授权'}
            </summary>
            {kind === 'source' && (
              <p>
                用户级节点权限开启后，仍需分配可使用的节点。按节点或分组保存会替换此节点源原有的分配范围。
              </p>
            )}
            {grants.map((grant) => (
              <div className="list-item" key={grant.id}>
                <span>
                  {items.find((item) => item.id === grant.id)?.name || grant.id}{' '}
                  {kind === 'source' &&
                    (grant.data.nodeScope
                      ? '· 已选 ' +
                        grant.data.nodeScope.nodeIds.length +
                        ' 个节点 / ' +
                        grant.data.nodeScope.groups.length +
                        ' 个分组 '
                      : '· 整个节点源 ')}
                  · {time(grant.data.endsAt || grant.data.expiresAt)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void save(path, 'PATCH', {
                      grants: [{ kind, resourceId: grant.id, enabled: false }],
                    })
                  }
                >
                  撤销此资源
                </button>
              </div>
            ))}
            <form
              className="fields"
              key={
                kind === 'source'
                  ? sourceId + JSON.stringify(sourceGrant?.data || {})
                  : kind
              }
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget),
                  resourceId =
                    kind === 'source' ? sourceId : nullable(data, 'resourceId');
                const enabled = data.get('grantAction') === 'allow';
                const nodeScope =
                  kind === 'source' &&
                  enabled &&
                  data.get('scope') === 'selection'
                    ? {
                        nodeIds: selected(data, 'nodeIds'),
                        groups: selected(data, 'nodeGroups'),
                      }
                    : undefined;
                if (
                  nodeScope &&
                  !nodeScope.nodeIds.length &&
                  !nodeScope.groups.length
                ) {
                  toast('请至少选择一个节点或分组');
                  return;
                }
                if (resourceId)
                  void save(path, 'PATCH', {
                    grants: [
                      {
                        kind,
                        resourceId,
                        enabled,
                        ...(nodeScope ? { nodeScope } : {}),
                        endsAt: nullable(data, 'endsAt'),
                      },
                    ],
                  });
              }}
            >
              {kind === 'source' ? (
                <>
                  <label>
                    <span>选择节点源</span>
                    <select
                      aria-label="选择节点源"
                      value={sourceId}
                      required
                      onChange={(event) => setSourceId(event.target.value)}
                    >
                      <option value="">请选择</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name || item.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {sourceId && (
                    <>
                      <label>
                        <span>分配范围</span>
                        <select
                          name="scope"
                          defaultValue={
                            sourceGrant && !sourceGrant.data.nodeScope
                              ? 'all'
                              : 'selection'
                          }
                        >
                          <option value="selection">按节点和分组分配</option>
                          <option value="all">整个节点源</option>
                        </select>
                      </label>
                      <Options
                        name="nodeIds"
                        label="选择节点（可多选）"
                        items={sourceNodes}
                        values={sourceGrant?.data.nodeScope?.nodeIds}
                        multiple
                      />
                      <Options
                        name="nodeGroups"
                        label="选择完整分组（可多选）"
                        items={sourceGroups.map((group) => ({
                          id: group,
                          name: group,
                        }))}
                        values={sourceGrant?.data.nodeScope?.groups}
                        multiple
                      />
                    </>
                  )}
                </>
              ) : (
                <Options name="resourceId" label="平台资源" items={items} />
              )}
              <Field
                name="endsAt"
                label="授权截止（UTC ISO，可留空）"
                value={
                  kind === 'source'
                    ? sourceGrant?.data.endsAt || sourceGrant?.data.expiresAt
                    : undefined
                }
              />
              <label>
                <span>授权操作</span>
                <select name="grantAction">
                  <option value="allow">授权或更新期限</option>
                  <option value="deny">禁止该资源</option>
                </select>
              </label>
              <button>
                {kind === 'source' ? '保存节点分配' : '保存资源权限'}
              </button>
            </form>
          </details>
        );
      })}
      <details>
        <summary>会话、订阅及体验资格</summary>
        <div className="actions">
          {['revokeSessions', 'revokeLinks', 'revokeTrial'].map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                const action = bulkActions[id];
                if (window.confirm('确认' + action.label + '？'))
                  void save(path, 'PATCH', action.patch);
              }}
            >
              {bulkActions[id].label}
            </button>
          ))}
        </div>
        <form
          className="fields"
          onSubmit={(event) => {
            event.preventDefault();
            void save(path, 'PATCH', {
              trialEndsAt: nullable(
                new FormData(event.currentTarget),
                'trialEndsAt',
              ),
            });
          }}
        >
          <Field name="trialEndsAt" label="延长体验至（UTC ISO）" required />
          <button>延长已有体验</button>
        </form>
      </details>
    </>
  );
}
