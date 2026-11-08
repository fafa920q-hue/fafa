import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe2, ShieldCheck } from 'lucide-react';
import {
  Badge,
  DataState,
  PageTitle,
  useData,
} from '../../../../packages/ui/src/core';
import './workspace.css';
type CatalogNode = {
  id: string;
  name: string;
  country: string;
  region: string;
  protocol: string;
  group: string;
  enabled: boolean;
  health: string;
  authorized: boolean;
  canSubscribe: boolean;
};
const flags: Record<string, string> = {
  香港: '🇭🇰',
  中国香港: '🇭🇰',
  日本: '🇯🇵',
  美国: '🇺🇸',
  新加坡: '🇸🇬',
  台湾: '🇹🇼',
  中国台湾: '🇹🇼',
  德国: '🇩🇪',
  英国: '🇬🇧',
};
export function NodeCatalog() {
  const catalog = useData<{ nodes: CatalogNode[]; serverTime: string }>(
    '/api/catalog/nodes',
  );
  const [search, setSearch] = useState(''),
    [country, setCountry] = useState(''),
    [protocol, setProtocol] = useState(''),
    [group, setGroup] = useState(''),
    [limit, setLimit] = useState(30);
  const nodes = catalog.data?.nodes || [];
  const filtered = useMemo(
    () =>
      nodes.filter(
        (n) =>
          (!country || n.country === country) &&
          (!protocol || n.protocol === protocol) &&
          (!group || n.group === group) &&
          (!search ||
            [n.name, n.country, n.region, n.group]
              .join(' ')
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [nodes, search, country, protocol, group],
  );
  return (
    <section className="v3-workspace">
      <PageTitle
        title="节点订阅"
        description="查看开放节点，订阅和使用范围由管理员授权。"
        eyebrow="FAFA ONE / NODES"
      />
      <div className="v3-catalog-toolbar">
        <input
          aria-label="搜索开放节点"
          placeholder="搜索节点、国家或地区…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(30);
          }}
        />
        {[
          {
            label: '国家和地区',
            value: country,
            set: setCountry,
            key: 'country',
          },
          { label: '协议', value: protocol, set: setProtocol, key: 'protocol' },
          { label: '分组', value: group, set: setGroup, key: 'group' },
        ].map((f) => (
          <select
            key={f.key}
            aria-label={f.label}
            value={f.value}
            onChange={(e) => {
              f.set(e.target.value);
              setLimit(30);
            }}
          >
            <option value="">全部{f.label}</option>
            {[
              ...new Set(
                nodes
                  .map((n) => n[f.key as 'country' | 'protocol' | 'group'])
                  .filter(Boolean),
              ),
            ]
              .sort()
              .map((value) => (
                <option key={value} value={value}>
                  {f.key === 'protocol' ? value.toUpperCase() : value}
                </option>
              ))}
          </select>
        ))}
        <button onClick={catalog.refresh}>刷新节点</button>
      </div>
      <DataState
        loading={!catalog.data && !catalog.error}
        error={catalog.error}
        onRetry={catalog.refresh}
      />
      {catalog.data && (
        <>
          <p className="v3-node-note">
            共 {filtered.length} 个开放展示节点 ·
            未进行连通性检测的节点会如实标记为“未检测”。
          </p>
          <div className="v3-node-grid">
            {filtered.slice(0, limit).map((node) => (
              <article className="glass v3-node" key={node.id}>
                <div className="v3-node-top">
                  <h2>
                    <span aria-hidden="true">
                      {flags[node.country] || '🌐'}
                    </span>{' '}
                    {node.name}
                  </h2>
                  <Badge>
                    {node.health === 'DISABLED'
                      ? '已停用'
                      : node.health === 'EXPIRED'
                        ? '已过期'
                        : '未检测'}
                  </Badge>
                </div>
                <div className="v3-node-meta">
                  <span>
                    {node.country}
                    {node.region ? ' · ' + node.region : ''}
                  </span>
                  <span>{node.protocol.toUpperCase()}</span>
                  {node.group && <span>{node.group}</span>}
                </div>
                <div className="v3-node-bottom">
                  <span>
                    <ShieldCheck size={13} />{' '}
                    {node.authorized ? '已获使用授权' : '尚未授权'}
                  </span>
                  {node.canSubscribe ? (
                    <Link className="button primary" to="/my-subscriptions">
                      管理订阅
                    </Link>
                  ) : (
                    <button disabled>未开放订阅</button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!filtered.length && (
            <div className="glass v3-node">
              <Globe2 size={24} />
              <h2>
                {nodes.length
                  ? '没有符合筛选条件的节点'
                  : '管理员尚未开放展示节点'}
              </h2>
              <p className="v3-node-note">
                节点由管理员统一添加和管理；普通用户不能添加平台节点。
              </p>
            </div>
          )}
          {filtered.length > limit && (
            <button onClick={() => setLimit(limit + 30)}>显示更多节点</button>
          )}
        </>
      )}
    </section>
  );
}
