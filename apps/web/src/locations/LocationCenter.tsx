import { useRef, useState, type FormEvent } from 'react';
import {
  Card,
  Badge,
  DataState,
  Empty,
  useApp,
  type Row,
} from '../../../../packages/ui/src/core';
import {
  coordinate,
  fromWgs84,
  toWgs84,
  parseMapLink,
  MapLinkError,
  type Point,
  type CoordinateSystem,
} from '../../../../packages/shared/src/wloc';
import { LocationMap } from './LocationMap';
import {
  deviceHosts,
  queryDevice,
  saveDevice,
  clearDevice,
  type DeviceHost,
} from './device';
import { SetupGuide } from './SetupGuide';
import './wloc.css';
const systems = ['WGS84', 'GCJ02', 'BD09'] as const;
export function LocationCenter({
  locations,
  onRefresh,
}: {
  locations: { data?: Row[]; error: string; refresh: () => void };
  onRefresh: () => void;
}) {
  const { request, session } = useApp();
  const writable = session.user.role !== 'Viewer';
  const [point, setPoint] = useState<Point>({
    latitude: 35.6762,
    longitude: 139.6503,
  });
  const [draft, setDraft] = useState({
    latitude: '35.6762',
    longitude: '139.6503',
  });
  const [system, setSystem] =
    useState<Exclude<CoordinateSystem, 'BD09MC'>>('WGS84');
  const [confirmed, setConfirmed] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(Point & { name: string })[]>([]);
  const [searched, setSearched] = useState(false);
  const [link, setLink] = useState('');
  const [linkSystem, setLinkSystem] = useState<CoordinateSystem | 'AUTO'>(
    'AUTO',
  );
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [host, setHost] = useState<DeviceHost>(deviceHosts[0]);
  const [accuracy, setAccuracy] = useState('25');
  const [radius, setRadius] = useState('0');
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState('尚未查询设备配置');
  function select(next: Point, known = true) {
    setPoint(next);
    setDraft({
      latitude: String(next.latitude),
      longitude: String(next.longitude),
    });
    setSystem('WGS84');
    setConfirmed(known);
    setStatus('');
  }
  async function action(label: string, task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    setStatus('');
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  function manual(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      select(toWgs84(coordinate(draft.latitude, draft.longitude), system));
      setStatus('坐标已转换为WGS84，请检查地图后保存');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const converted = fromWgs84(point, 'GCJ02'),
    baidu = fromWgs84(point, 'BD09');
  return (
    <div className="wloc-center stack">
      <Card
        title="地图选点与搜索"
        description="拖动或点击地图选点；搜索地址会发送给Photon地图服务，瓦片请求发送给OpenStreetMap。"
      >
        <form
          className="wloc-search wloc-row"
          onSubmit={(event) => {
            event.preventDefault();
            void action('搜索', async () => {
              const data = await request<{
                results: (Point & { name: string })[];
              }>(
                '/api/location-tools/search?q=' +
                  encodeURIComponent(query.trim()),
              );
              setResults(data.results);
              setSearched(true);
              setStatus(
                data.results.length
                  ? '请选择搜索结果'
                  : '未找到匹配地点，可改用坐标或地图',
              );
            });
          }}
        >
          <label>
            国家、城市、街道或地址
            <input
              aria-label="地点搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              required
              minLength={2}
              maxLength={160}
              placeholder="例如 东京站、Paris、台北"
            />
          </label>
          <button className="primary" disabled={!!busy}>
            {busy === '搜索' ? '搜索中…' : '搜索地点'}
          </button>
        </form>
        {searched && (
          <small>
            © OpenStreetMap contributors · Photon · 结果仅供选点，请核对。
          </small>
        )}
        <div className="wloc-results">
          {results.map((r, i) => (
            <button
              key={i}
              disabled={!!busy}
              onClick={() => {
                select(r);
                setName(r.name.slice(0, 80));
                setResults([]);
              }}
            >
              {r.name}{' '}
              <small>
                {r.latitude.toFixed(6)}, {r.longitude.toFixed(6)}
              </small>
            </button>
          ))}
        </div>
        <LocationMap
          point={point}
          onSelect={(p) => {
            if (!lock.current) select(p);
          }}
        />
        <p className="wloc-coordinate" data-testid="selected-coordinate">
          当前WGS84：{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}
        </p>
        <form onSubmit={manual} className="wloc-row">
          <label>
            输入坐标系
            <select
              aria-label="输入坐标系"
              value={system}
              onChange={(e) => setSystem(e.target.value as typeof system)}
            >
              {systems.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            纬度
            <input
              aria-label="纬度"
              type="number"
              inputMode="decimal"
              step="any"
              min={-90}
              max={90}
              required
              value={draft.latitude}
              onChange={(e) => {
                setDraft({ ...draft, latitude: e.target.value });
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            经度
            <input
              aria-label="经度"
              type="number"
              inputMode="decimal"
              step="any"
              min={-180}
              max={180}
              required
              value={draft.longitude}
              onChange={(e) => {
                setDraft({ ...draft, longitude: e.target.value });
                setConfirmed(false);
              }}
            />
          </label>
          <button disabled={!!busy}>应用坐标</button>
        </form>
        <details>
          <summary>查看转换后的坐标</summary>
          <p>
            GCJ-02：{converted.latitude.toFixed(6)},{' '}
            {converted.longitude.toFixed(6)}
            <br />
            BD-09：{baidu.latitude.toFixed(6)}, {baidu.longitude.toFixed(6)}
          </p>
        </details>
        <form
          className="wloc-row"
          onSubmit={(event) => {
            event.preventDefault();
            void action('解析', async () => {
              let parsed;
              try {
                parsed = parseMapLink(link, linkSystem);
              } catch (e) {
                if (
                  !(e instanceof MapLinkError) ||
                  e.code !== 'EXPAND_REQUIRED'
                )
                  throw e;
                parsed = await request<Point & { name: string }>(
                  '/api/location-tools/resolve?url=' +
                    encodeURIComponent(link) +
                    '&system=' +
                    linkSystem,
                );
              }
              select(parsed);
              if (parsed.name) setName(parsed.name);
              setStatus('地图链接已解析，请核对坐标');
            });
          }}
        >
          <label className="wloc-grow">
            地图分享链接
            <input
              aria-label="地图分享链接"
              type="text"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              maxLength={4096}
              placeholder="苹果 / 高德 / 百度 / Google Maps HTTPS链接"
              required
            />
          </label>
          <label>
            链接坐标系
            <select
              aria-label="链接坐标系"
              value={linkSystem}
              onChange={(e) =>
                setLinkSystem(e.target.value as typeof linkSystem)
              }
            >
              <option value="AUTO">按已知格式识别</option>
              {systems.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <button disabled={!!busy}>
            {busy === '解析' ? '解析中…' : '解析链接'}
          </button>
        </form>
        <small>
          中国及邻近区域的苹果/Google分享坐标系可能不明确，需手动确认；无法解析的短链接请改用含坐标长链接。不会静默改变坐标系。
        </small>
      </Card>
      <Card
        title="保存到当前设备"
        description="请求由当前浏览器直接发送，小火箭必须在这台设备上运行；平台收藏与设备配置相互独立。"
      >
        <Badge tone="warning">实验性 · 真实iOS定位未验收</Badge>
        <div className="wloc-row">
          <label>
            原版模块接口
            <select
              aria-label="原版模块接口"
              value={host}
              disabled={!!busy}
              onChange={(e) => {
                setHost(e.target.value as DeviceHost);
                setDeviceStatus('已更换接口，请重新查询');
              }}
            >
              {deviceHosts.map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
          </label>
          <label>
            精度（米）
            <input
              aria-label="精度（米）"
              type="number"
              min={1}
              max={10000}
              value={accuracy}
              disabled={!!busy}
              onChange={(e) => setAccuracy(e.target.value)}
            />
          </label>
          <label>
            随机半径（米）
            <input
              aria-label="随机半径（米）"
              type="number"
              min={0}
              max={100000}
              value={radius}
              disabled={!!busy}
              onChange={(e) => setRadius(e.target.value)}
            />
          </label>
        </div>
        {!confirmed && (
          <p role="alert">
            坐标尚未确认。旧预设未记录坐标系，或输入尚未应用；请明确坐标系并点击“应用坐标”，再保存。
          </p>
        )}
        <div className="wloc-row">
          <button
            disabled={!!busy}
            onClick={() =>
              void action('查询', async () => {
                setDeviceStatus('查询中…');
                try {
                  const data = await queryDevice(host);
                  setDeviceStatus(
                    data
                      ? '设备配置：' +
                          data.latitude +
                          ', ' +
                          data.longitude +
                          ' · 精度' +
                          data.accuracy +
                          'm · 半径' +
                          data.randomRadius +
                          'm'
                      : '设备无已保存坐标',
                  );
                } catch (e) {
                  setDeviceStatus('查询失败，设备状态未知');
                  throw e;
                }
              })
            }
          >
            查询设备配置
          </button>
          <button
            className="primary"
            disabled={!!busy || !confirmed}
            onClick={() =>
              void action('保存设备', async () => {
                setDeviceStatus('正在写入并回读…');
                try {
                  const actual = await saveDevice(
                    host,
                    point,
                    Number(accuracy),
                    Number(radius),
                  );
                  setDeviceStatus(
                    '设备配置已保存并回读一致：' +
                      actual.latitude +
                      ', ' +
                      actual.longitude +
                      '；系统定位仍须真机验证',
                  );
                } catch (e) {
                  setDeviceStatus('保存未确认，设备状态未知；请先查询再操作');
                  throw e;
                }
              })
            }
          >
            {busy === '保存设备' ? '保存并验证中…' : '保存到设备'}
          </button>
          <button
            className="danger"
            disabled={!!busy}
            onClick={() => setClearOpen(true)}
          >
            清除设备配置
          </button>
        </div>
        {clearOpen && (
          <div className="callout">
            <p>
              确认清除当前设备模块保存的坐标？如修改过模块静态参数，还需恢复默认值或停用模块。
            </p>
            <div className="wloc-row">
              <button disabled={!!busy} onClick={() => setClearOpen(false)}>
                取消清除
              </button>
              <button
                className="danger"
                disabled={!!busy}
                onClick={() =>
                  void action('清除', async () => {
                    setDeviceStatus('正在清除并回读…');
                    try {
                      await clearDevice(host);
                      setClearOpen(false);
                      setDeviceStatus(
                        '设备配置已清除并回读为空；请按恢复指引核验真实定位',
                      );
                    } catch (e) {
                      setDeviceStatus('清除未确认，设备状态未知');
                      throw e;
                    }
                  })
                }
              >
                确认清除
              </button>
            </div>
          </div>
        )}
        <p role="status" data-testid="device-status">
          {deviceStatus}
        </p>
        <SetupGuide />
      </Card>
      <Card
        title="我的常用地点"
        description="收藏仅保存在自己的FAFA ONE账户；切换后再按需保存到当前设备。"
      >
        {writable && (
          <form
            className="wloc-row"
            onSubmit={(event) => {
              event.preventDefault();
              void action('收藏', async () => {
                await request('/api/location_presets', 'POST', {
                  name: name.trim(),
                  ...point,
                  coordinateSystem: 'WGS84',
                  country: '',
                });
                onRefresh();
                setStatus('地点已收藏到你的账户，尚未写入设备');
              });
            }}
          >
            <label className="wloc-grow">
              地点名称
              <input
                aria-label="地点名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={1}
                maxLength={80}
              />
            </label>
            <button disabled={!!busy || !confirmed}>
              {busy === '收藏' ? '收藏中…' : '收藏当前地点'}
            </button>
          </form>
        )}
        <label>
          筛选收藏
          <input
            aria-label="筛选收藏"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <DataState
          error={locations.error}
          loading={!locations.data && !locations.error}
          onRetry={locations.refresh}
        />
        {locations.data?.length === 0 && (
          <Empty
            title="暂无常用地点"
            description="先搜索或选点，再在上方填写名称并收藏。"
          />
        )}
        <div className="wloc-favorites">
          {locations.data
            ?.filter((r) => String(r.name).includes(filter))
            .map((r) => (
              <article key={r.id} className="resource-card">
                <h3>{r.name}</h3>
                <small>
                  {r.latitude}, {r.longitude} ·{' '}
                  {r.coordinateSystem || '旧预设：坐标系待确认'}
                </small>
                <div className="wloc-row">
                  <button
                    disabled={!!busy}
                    onClick={() => {
                      select(
                        coordinate(r.latitude, r.longitude),
                        r.coordinateSystem === 'WGS84',
                      );
                      setName(r.name);
                    }}
                  >
                    选择地点
                  </button>
                  {writable && (
                    <button
                      className="danger"
                      disabled={!!busy}
                      onClick={() => {
                        if (window.confirm('从你的账户移除此收藏？'))
                          void action('删除收藏', async () => {
                            await request(
                              '/api/location_presets/' + r.id,
                              'DELETE',
                            );
                            onRefresh();
                            setStatus('收藏已删除');
                          });
                      }}
                    >
                      删除收藏
                    </button>
                  )}
                </div>
              </article>
            ))}
        </div>
      </Card>
      {busy && (
        <p role="status" className="wloc-feedback">
          正在{busy}…
        </p>
      )}
      {error && (
        <p role="alert" className="callout wloc-feedback">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="callout wloc-feedback">
          {status}
        </p>
      )}
    </div>
  );
}
