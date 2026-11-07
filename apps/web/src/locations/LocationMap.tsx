import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Point } from '../../../../packages/shared/src/wloc';
export function LocationMap({
  point,
  onSelect,
}: {
  point: Point;
  onSelect: (point: Point) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  const marker = useRef<L.Marker | undefined>(undefined);
  const layer = useRef<L.TileLayer | undefined>(undefined);
  const selected = useRef(onSelect);
  selected.current = onSelect;
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const m = L.map(container.current, {
      zoomControl: true,
      worldCopyJump: true,
    }).setView([point.latitude, point.longitude], 5);
    map.current = m;
    const tiles = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        referrerPolicy: 'origin',
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      },
    ).addTo(m);
    layer.current = tiles;
    tiles.on('tileerror', () => setFailed(true));
    const pin = L.marker([point.latitude, point.longitude], {
      draggable: true,
      icon: L.divIcon({
        className: 'wloc-pin',
        html: '<span aria-hidden="true">●</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(m);
    marker.current = pin;
    const pick = (lat: number, lon: number) =>
      selected.current({
        latitude: Math.max(-90, Math.min(90, lat)),
        longitude: ((((lon + 180) % 360) + 360) % 360) - 180,
      });
    m.on('click', (event: L.LeafletMouseEvent) =>
      pick(event.latlng.lat, event.latlng.lng),
    );
    m.on('dragend', () => {
      const c = m.getCenter();
      pick(c.lat, c.lng);
    });
    pin.on('dragend', () => {
      const c = pin.getLatLng();
      pick(c.lat, c.lng);
    });
    const resize = new ResizeObserver(() =>
      m.invalidateSize({ animate: false }),
    );
    resize.observe(container.current);
    setReady(true);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = undefined;
      marker.current = undefined;
      layer.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!map.current || !marker.current) return;
    const display = {
      lat: Math.max(-85.0511, Math.min(85.0511, point.latitude)),
      lng: point.longitude,
    };
    marker.current.setLatLng(display);
    const center = map.current.getCenter();
    if (
      Math.abs(center.lat - display.lat) > 0.000001 ||
      Math.abs(center.lng - display.lng) > 0.000001
    )
      map.current.setView(display, map.current.getZoom(), { animate: false });
  }, [point]);
  return (
    <div className="wloc-map-wrap">
      <div
        ref={container}
        className="wloc-map"
        role="region"
        aria-label="全球地图，拖动地图或标记选点"
        data-ready={String(ready)}
      />
      {Math.abs(point.latitude) > 85.0511 && (
        <p role="status">极区超出墨卡托底图显示范围，原始坐标保持不变。</p>
      )}
      {failed && (
        <p role="alert">
          部分地图瓦片加载失败，可继续使用坐标或收藏。
          <button
            onClick={() => {
              setFailed(false);
              layer.current?.redraw();
            }}
          >
            重试地图
          </button>
        </p>
      )}
      <small>
        拖动地图以中心选点，或点击地点、拖动标记；底图为WGS84。
        <a
          href="https://www.openstreetmap.org/fixthemap"
          target="_blank"
          rel="noreferrer"
        >
          报告地图问题
        </a>
      </small>
    </div>
  );
}
