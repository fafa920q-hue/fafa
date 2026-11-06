import { useState } from 'react';
import { MapPin, Globe2, LocateOff, Plus } from 'lucide-react';
import {
  Card,
  PageTitle,
  useData,
  useApp,
  FormDialog,
  ConfirmDialog,
  Empty,
  Badge,
  LocationPreview,
  type Row,
} from '../../../../packages/ui/src/core';
export function Locations() {
  const { request, toast, session } = useApp();
  const locations = useData<Row[]>('/api/location_presets');
  const sources = useData<Row[]>('/api/node_sources');
  const profile = useData<any>('/api/subscription/profile');
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<Row>();
  const [q, setQ] = useState('');
  const writable = session.user.role !== 'Viewer';
  return (
    <>
      <PageTitle
        title="位置中心"
        description="让出口策略和地点预设各归其位，能力边界清晰可见。"
        action={
          writable && (
            <button className="primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              添加位置预设
            </button>
          )
        }
      />
      <div className="stack">
        <div className="capabilities">
          <div className="capability">
            <Globe2 color="var(--primary)" />
            <h3>IP 出口地区</h3>
            <p>
              从实际获授权节点中选择地区，限制订阅导出节点范围，仅影响代理流量的出口
              IP。
            </p>
            <Badge>支持 · 需要真实节点</Badge>
          </div>
          <div className="capability">
            <MapPin color="var(--primary)" />
            <h3>地图位置预设</h3>
            <p>
              保存经纬度配置。当前为本地坐标示意，未接入地图供应商，不会向地图平台发送位置。
            </p>
            <Badge>支持 · 坐标保存</Badge>
          </div>
          <div className="capability">
            <LocateOff color="var(--primary)" />
            <h3>系统 GPS 定位</h3>
            <p>
              网页和 Shadowrocket 代理规则不能修改 iPhone Core Location。iOS
              26.3 真机兼容性仍待人工验证。
            </p>
            <Badge tone="warning">暂不支持 · 不会重启生效</Badge>
          </div>
        </div>
        <Card
          title="IP 出口策略"
          description="修改后客户端需要更新订阅并自行连接节点"
          icon={Globe2}
        >
          <div className="toolbar">
            <select
              aria-label="出口地区"
              disabled={!writable}
              value={profile.data?.country || ''}
              onChange={(e) =>
                request('/api/subscription/profile', 'PUT', {
                  country: e.target.value,
                })
                  .then(() => {
                    profile.refresh();
                    toast('出口地区筛选已保存，请在客户端更新订阅');
                  })
                  .catch(() => {})
              }
            >
              <option value="">全部已授权地区</option>
              {[
                ...new Set(
                  sources.data
                    ?.filter((s) => !s.demo && s.nodeCount > 0)
                    .map((s) => s.country) || [],
                ),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <p className="callout">
            这里保存的是订阅导出筛选规则，不会更改本机网络或
            GPS。小火箭须由用户在客户端导入订阅并选择策略；未完成真机导入验收。
          </p>
        </Card>
        <Card
          title="我的地点预设"
          description="按名称筛选已保存地点；在线地图 / 城市搜索供应商尚未接入"
          icon={MapPin}
        >
          <div className="toolbar">
            <input
              aria-label="搜索位置预设"
              placeholder="搜索已保存的位置…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="resource-grid">
            {locations.data
              ?.filter((r) => r.name.includes(q))
              .map((r) => (
                <article key={r.id} className="resource-card">
                  <div className="resource-top">
                    <h3>{r.name}</h3>
                    <Badge>{r.demo ? '演示预设' : '坐标配置'}</Badge>
                  </div>
                  <LocationPreview
                    latitude={r.latitude}
                    longitude={r.longitude}
                  />
                  <div className="resource-meta">
                    <span>
                      {r.country} · {r.latitude}, {r.longitude}
                    </span>
                    <span>仅保存于平台，不改变系统定位。</span>
                  </div>
                  {writable && (
                    <button className="danger" onClick={() => setRemove(r)}>
                      删除预设
                    </button>
                  )}
                </article>
              ))}
          </div>
          {locations.data?.length === 0 && (
            <Empty
              title="暂无位置预设"
              description="添加经纬度，即可保存你的常用地点。"
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={add}
        onClose={() => setAdd(false)}
        title="添加位置预设"
        fields={[
          { name: 'name', label: '地点名称', required: true },
          { name: 'country', label: '国家 / 地区' },
          {
            name: 'latitude',
            label: '纬度（-90 至 90）',
            type: 'number',
            step: 'any',
            min: -90,
            max: 90,
            required: true,
          },
          {
            name: 'longitude',
            label: '经度（-180 至 180）',
            type: 'number',
            step: 'any',
            min: -180,
            max: 180,
            required: true,
          },
        ]}
        notice="仅保存地图坐标配置，不会修改任何设备 GPS。"
        onSubmit={async (d) => {
          await request('/api/location_presets', 'POST', d);
          locations.refresh();
          toast('位置预设已保存');
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除此预设？"
        description="该位置将从你的预设列表中移除。"
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          await request('/api/location_presets/' + remove!.id, 'DELETE');
          locations.refresh();
        }}
      />
    </>
  );
}
