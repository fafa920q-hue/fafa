import { Globe2 } from 'lucide-react';
import { Card, PageTitle, useData, useApp, type Row } from '../../../../packages/ui/src/core';
import { LocationCenter } from '../locations/LocationCenter';
export function Locations() {
  const { request, toast, session } = useApp();
  const locations = useData<Row[]>('/api/location_presets');
  const sources = useData<Row[]>('/api/node_sources');
  const profile = useData<any>('/api/subscription/profile');
  const writable = session.user.role !== 'Viewer';
  return <>
    <PageTitle title="位置中心" description="搜索、选点、收藏与设备配置。WLOC为实验性网络定位模块；IP出口策略独立管理。" />
    <div className="stack">
      <LocationCenter locations={locations} onRefresh={locations.refresh} />
      <Card title="IP 出口策略" description="修改后客户端需要更新订阅并自行连接节点" icon={Globe2}>
        <div className="toolbar">
          <select aria-label="出口地区" disabled={!writable || !profile.data} value={profile.data?.country || ''} onChange={(e) =>
            request('/api/subscription/profile', 'PUT', { ...profile.data, country: e.target.value }).then(() => { profile.refresh(); toast('出口地区筛选已保存，请在客户端更新订阅'); }).catch(() => {})}>
            <option value="">全部已授权地区</option>
            {[...new Set(sources.data?.filter((s) => !s.demo && s.nodeCount > 0).map((s) => s.country) || [])].map((country) => <option key={country}>{country}</option>)}
          </select>
        </div>
        <p className="callout">这里保存订阅导出筛选规则，不会更改本机网络或GPS。不会改变Google身份、Owner绑定或节点配置。</p>
      </Card>
    </div>
  </>;
}
