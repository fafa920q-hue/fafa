import { useState } from 'react';
import {
  Card,
  FormDialog,
  useApp,
  useData,
  type Row,
  type Field,
} from '../../../../packages/ui/src/core';
export function NodeManager({ onChanged }: { onChanged: () => void }) {
  const { request, session, toast } = useApp();
  const nodes = useData<Row[]>('/api/nodes');
  const profile = useData<any>('/api/subscription/profile');
  const [importing, setImporting] = useState(false);
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
    { name: 'name', label: '节点批次名称', required: true },
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
  return (
    <Card
      title="节点批量导入与管理"
      description="连接状态均待真实验证；同名不同连接保留，相同连接去重并保留别名与标签"
    >
      <div className="toolbar">
        {writable && (
          <button onClick={() => setImporting(true)}>
            批量预览 / 导入节点
          </button>
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
      {nodes.error && <p role="alert">{nodes.error}</p>}
      <div className="resource-grid">
        {(nodes.data || []).map((node) => (
          <article className="resource-card" key={node.id}>
            <h3>{node.name}</h3>
            <p>
              {node.country} · {node.protocol} ·{' '}
              {groupLabel(node.group) || '未分组'}
            </p>
            <p>{[...(node.tags || []), ...(node.aliases || [])].join(' · ')}</p>
            <p>
              {node.status === 'DISABLED' ? '已禁用' : '待真实验证'} ·
              延迟、流量未测
            </p>
            {writable && node.ownerId === session.user.id && (
              <div className="actions">
                <button onClick={() => setEdit(node)}>编辑标签 / 分组</button>
                <button onClick={() => setReplace(node)}>替换连接配置</button>
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
      <FormDialog
        open={importing}
        onClose={() => setImporting(false)}
        title="预览节点（不保存凭据）"
        fields={fields}
        onSubmit={async (data) => {
          const result = await request(
            '/api/node-import/preview',
            'POST',
            data,
          );
          setPreview({ data, result });
        }}
      />
      {preview && (
        <div className="callout">
          <p>
            有效 {preview.result.valid} · 重复 {preview.result.duplicates} ·
            解析失败 {preview.result.failures.length} · 所有有效节点待验证
          </p>
          {preview.result.failures.map((failure: any) => (
            <p key={failure.line}>第 {failure.line} 行解析失败（不显示原文）</p>
          ))}
          <button
            disabled={!preview.result.valid}
            onClick={async () => {
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
              }
            }}
          >
            确认授权并加密导入
          </button>
          <button onClick={() => setPreview(undefined)}>
            取消并清除待导入内容
          </button>
        </div>
      )}
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
        ]}
        onSubmit={async (data) => {
          await request('/api/nodes/' + edit!.id, 'PATCH', data);
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
