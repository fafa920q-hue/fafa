import { useState } from 'react';

export function PolicyTimeField({
  name,
  label,
  value,
  required = false,
}: {
  name: string;
  label: string;
  value?: string | null;
  required?: boolean;
}) {
  const [iso, setIso] = useState(value || '');
  const timestamp = Date.parse(iso);
  return (
    <div className="reg-time">
      <label>
        <span>
          {label} <small>（UTC）</small>
        </span>
        <input
          aria-label={label + '（UTC）'}
          type="datetime-local"
          step={1}
          value={
            Number.isFinite(timestamp)
              ? new Date(timestamp).toISOString().slice(0, 19)
              : ''
          }
          required={required}
          onChange={(event) => {
            const next = event.target.value;
            setIso(next ? new Date(next + 'Z').toISOString() : '');
          }}
        />
      </label>
      <details className="reg-time-advanced">
        <summary>手动输入 ISO 时间</summary>
        <label>
          <span>可带时区偏移，例如 +08:00</span>
          <input
            name={name}
            aria-label={label + ' ISO'}
            value={iso}
            onChange={(event) => setIso(event.target.value)}
          />
        </label>
      </details>
    </div>
  );
}

export function PolicyMultiSelect({
  name,
  label,
  items,
  values,
}: {
  name: string;
  label: string;
  items: { id: string; name: string }[];
  values?: string[];
}) {
  const [selected, setSelected] = useState(() => new Set(values || []));
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  return (
    <details className="reg-multi">
      <summary>
        <span>{label}</span>
        <small>
          已选 {items.filter((item) => selected.has(item.id)).length} 项
        </small>
      </summary>
      <input
        type="search"
        aria-label={'搜索' + label}
        placeholder="输入名称搜索…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="reg-options">
        {items.map((item) => (
          <label
            key={item.id}
            hidden={!(item.name || item.id).toLowerCase().includes(term)}
          >
            <input
              name={name}
              value={item.id}
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={(event) => {
                const checked = event.target.checked;
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                });
              }}
            />
            <span>{item.name || item.id}</span>
          </label>
        ))}
        {!items.some((item) =>
          (item.name || item.id).toLowerCase().includes(term),
        ) && <small>没有匹配项</small>}
      </div>
    </details>
  );
}
