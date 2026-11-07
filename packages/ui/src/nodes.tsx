import { useEffect, useState } from 'react';
import {
  Card,
  Dialog,
  Empty,
  Badge,
  DataState,
  FormDialog,
  useApp,
  useData,
  type Row,
  type Field,
} from './core';
export type ImportMode = 'single' | 'batch';
export function NodeManager({
  onChanged,
  importMode,
  onImportModeChange,
  refreshVersion = 0,
}: {
  onChanged: () => void;
  importMode?: ImportMode;
  onImportModeChange?: (mode?: ImportMode) => void;
  refreshVersion?: number;
}) {
  const { request, session, toast } = useApp();
  const nodes = useData<Row[]>('/api/nodes');
  const profile = useData<any>('/api/subscription/profile');
  const [localMode, setLocalMode] = useState<ImportMode>();
  const mode = onImportModeChange ? importMode : localMode;
  const setMode = onImportModeChange || setLocalMode;
  const [importBusy, setImportBusy] = useState(false);
  useEffect(() => {
    nodes.refresh();
  }, [refreshVersion]);
  const [edit, setEdit] = useState<Row>();
  const [replace, setReplace] = useState<Row>();
  const [preview, setPreview] = useState<any>();
  const writable = session.user.role !== 'Viewer';
  const admin = ['Owner', 'Admin'].includes(session.user.role);
  const groupNames: Record<string, string> = {
    OWNED_NODE: '自有节点',
    THIRD_PARTY_NODE: '第三方授权节点',
    REMOTE_SUBSCRIPTION: '第三方授权订阅',
  };
  const groupLabel = (value: string) => groupNames[value] || value;
  const reload = () => {
    nodes.refresh();
    onChanged();
  };
  const fields: Field[] = [
    {
      name: 'name',
      label: mode === 'single' ? '节点名称' : '节点批次名称',
      required: true,
    },
    { name: 'group', label: '节点分组' },
    {
      name: 'kind',
      label: '节点归属',
      options: [
        { label: '自有节点', value: 'OWNED_NODE' },
        ...(admin
          ? [{ label: '第三方授权节点', value: 'THIRD_PARTY_NODE' }]
          : []),
      ],
    },
    {
      name: 'content',
      label: '节点配置（敏感）',
      type: 'textarea',
      required: true,
      help: '仅输入已轮换的 SS / VMess URI、Base64 或支持的 JSON/YAML；不回显已保存的凭据。',
    },
    {
      name: 'authorizationReference',
      label: '第三方聚合、再分发授权依据',
      help: '第三方节点必填：提供商条款或授权说明，不要填写密码。',
    },
    {
      name: 'authorized',
      label: '我有权使用并聚合这些节点',
      type: 'checkbox',
      required: true,
    },
    {
      name: 'redistributionAuthorized',
      label: '提供商已允许向获授权用户再分发',
      type: 'checkbox',
    },
  ];
  const filter = async (key: string, value: string) => {
    try {
      await request('/api/subscription/profile', 'PUT', {
        ...profile.data,
        [key]: value,
      });
      profile.refresh();
      toast('订阅筛选已保存，所有新旧链接均按此权限导出');
    } catch {
      /* 由共享请求组件显示错误 */
    }
  };
  const visible = (nodes.data || []).filter(
    (node) =>
      (!profile.data?.country || node.country === profile.data.country) &&
      (!profile.data?.protocol || node.protocol === profile.data.protocol) &&
      (!profile.data?.group || node.group === profile.data.group),
  );
  return (
    <Card
      title="节点批量导入与管理"
      description="连接状态均待真实验证；同名不同连接保留，相同连接去重并保留别名与标签"
    >
      <div className="toolbar">
        {writable && !onImportModeChange && (
          <>
            <button onClick={() => setMode('single')}>新增节点</button>
            <button onClick={() => setMode('batch')}>批量导入</button>
          </>
        )}
        <select
          disabled={!writable}
          aria-label="订阅国家筛选"
          value={profile.data?.country || ''}
          onChange={(event) => void filter('country', event.target.value)}
        >
          <option value="">全部国家</option>
          {[...new Set((nodes.data || []).map((node) => node.country))]
            .filter(Boolean)
            .map((country) => (
              <option key={country}>{country}</option>
            ))}
        </select>
        <select
          disabled={!writable}
          aria-label="订阅协议筛选"
          value={profile.data?.protocol || ''}
          onChange={(event) => void filter('protocol', event.target.value)}
        >
          <option value="">全部协议</option>
          {['ss', 'vmess', 'vless', 'trojan', 'hysteria2'].map((protocol) => (
            <option key={protocol}>{protocol}</option>
          ))}
        </select>
        <select
          disabled={!writable}
          aria-label="订阅分组筛选"
          value={profile.data?.group || ''}
          onChange={(event) => void filter('group', event.target.value)}
        >
          <option value="">全部分组</option>
          {[...new Set((nodes.data || []).map((node) => node.group))]
            .filter(Boolean)
            .map((group) => (
              <option key={group} value={group}>
                {groupLabel(group)}
              </option>
            ))}
        </select>
      </div>
      <DataState
        error={nodes.error}
        loading={!nodes.data}
        onRetry={nodes.refresh}
      />
      <DataState
        error={profile.error}
        loading={false}
        onRetry={profile.refresh}
      />
      <div className="resource-grid">
        {visible.map((node) => (
          <article className="resource-card" key={node.id}>
            <h3>{node.name}</h3>
            <Badge>
              {node.shared || node.ownerId !== session.user.id
                ? '获授权 · 只读'
                : '本人拥有 · 可管理'}
            </Badge>
            <p>
              {node.country} · {node.protocol} ·{' '}
              {groupLabel(node.group) || '未分组'}
            </p>
            <p>{[...(node.tags || []), ...(node.aliases || [])].join(' · ')}</p>
            <p>
              {node.status === 'DISABLED'
                ? '已禁用'
                : node.status === 'EXPIRED'
                  ? '已过期'
                  : '待真实验证'}{' '}
              · 延迟、流量未测
            </p>
            {writable &&
              (node.editable ?? node.ownerId === session.user.id) && (
                <div className="actions">
                  <button onClick={() => setEdit(node)}>编辑标签 / 分组</button>
                  {node.sourceKind !== 'REMOTE_SUBSCRIPTION' && (
                    <button onClick={() => setReplace(node)}>
                      替换连接配置
                    </button>
                  )}
                  <button
                    onClick={() =>
                      void request('/api/nodes/' + node.id, 'PATCH', {
                        enabled: !node.enabled,
                      })
                        .then(reload)
                        .catch(() => {})
                    }
                  >
                    {node.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm('删除此节点并停止订阅导出？'))
                        void request('/api/nodes/' + node.id, 'DELETE')
                          .then(reload)
                          .catch(() => {});
                    }}
                  >
                    删除节点
                  </button>
                </div>
              )}
          </article>
        ))}
      </div>
      {!nodes.error && nodes.data && visible.length === 0 && (
        <Empty
          title="暂无匹配的节点"
          description="添加单个节点或批量导入已获授权的节点；连接状态以真实检测为准。"
          action={
            writable && (
              <div className="actions">
                <button
                  className="primary"
                  aria-label="从空状态新增节点"
                  onClick={() => setMode('single')}
                >
                  新增节点
                </button>
                <button
                  aria-label="从空状态批量导入"
                  onClick={() => setMode('batch')}
                >
                  批量导入
                </button>
              </div>
            )
          }
        />
      )}
      <FormDialog
        open={!!mode}
        onClose={() => setMode(undefined)}
        title={mode === 'single' ? '新增节点' : '批量导入节点'}
        submitLabel="预览并验证"
        notice="仅导入你拥有使用与再分发授权的第三方节点。请先轮换曾公开的凭据；配置仅在本次预览中保留，不会回显已存储的密码或 UUID。"
        fields={fields}
        onSubmit={async (data) => {
          const result = await request(
            '/api/node-import/preview',
            'POST',
            data,
          );
          if (
            mode === 'single' &&
            (result.total !== 1 || result.valid !== 1 || result.failures.length)
          )
            throw new Error(
              '新增节点仅接受一个有效配置；多个节点请使用批量导入。',
            );
          setPreview({ data, result });
        }}
      />
      <Dialog
        open={!!preview}
        onClose={() => {
          if (!importBusy) setPreview(undefined);
        }}
        title="节点导入预览"
      >
        {preview && (
          <div className="callout">
            <p>原始条目 {preview.result.total}</p>
            <div role="group" aria-label="预览地区统计">
              地区：
              {Object.entries(preview.result.countries || {}).map(
                ([name, count]) => (
                  <span key={name}>
                    {name} {String(count)}{' '}
                  </span>
                ),
              )}
            </div>
            <div role="group" aria-label="预览协议统计">
              协议：
              {Object.entries(preview.result.protocols || {}).map(
                ([name, count]) => (
                  <span key={name}>
                    {name} {String(count)}{' '}
                  </span>
                ),
              )}
            </div>
            <p>
              有效 {preview.result.valid} · 重复 {preview.result.duplicates} ·
              解析失败 {preview.result.failures.length} · 所有有效节点待验证
            </p>
            {preview.result.failures.map((failure: any) => (
              <p key={failure.line}>
                第 {failure.line} 行解析失败（不显示原文）
              </p>
            ))}
            <button
              disabled={!preview.result.valid || importBusy}
              onClick={async () => {
                setImportBusy(true);
                try {
                  const result = await request(
                    '/api/node-import',
                    'POST',
                    preview.data,
                  );
                  setPreview(undefined);
                  reload();
                  toast('已加密导入 ' + result.imported + ' 个节点');
                } catch {
                  setPreview(undefined);
                } finally {
                  setImportBusy(false);
                }
              }}
            >
              确认授权并加密导入
            </button>
            <button disabled={importBusy} onClick={() => setPreview(undefined)}>
              取消并清除待导入内容
            </button>
          </div>
        )}
      </Dialog>
      <FormDialog
        open={!!edit}
        onClose={() => setEdit(undefined)}
        title="编辑节点标签与分组"
        fields={[
          {
            name: 'name',
            label: '节点名称',
            required: true,
            value: edit?.name,
          },
          { name: 'country', label: '国家 / 地区', value: edit?.country },
          { name: 'group', label: '分组', value: edit?.group },
          {
            name: 'tags',
            label: '标签（每行一个）',
            type: 'textarea',
            value: (edit?.tags || []).join('\n'),
          },
        ]}
        onSubmit={async (data) => {
          await request('/api/nodes/' + edit!.id, 'PATCH', {
            ...data,
            tags: String(data.tags || '')
              .split(/\r?\n/)
              .map((tag) => tag.trim())
              .filter(Boolean),
          });
          reload();
        }}
      />
      <FormDialog
        open={!!replace}
        onClose={() => setReplace(undefined)}
        title="替换一个节点配置"
        notice="远程订阅节点由上游维护；本地导入节点可以替换。已保存凭据不会回显。"
        fields={[
          {
            name: 'content',
            label: '新节点配置（敏感）',
            type: 'textarea',
            required: true,
          },
          {
            name: 'authorized',
            label: '我拥有此节点使用授权',
            type: 'checkbox',
            required: true,
          },
        ]}
        onSubmit={async (data) => {
          await request('/api/nodes/' + replace!.id, 'PUT', data);
          reload();
        }}
      />
    </Card>
  );
}
