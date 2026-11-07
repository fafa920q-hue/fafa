import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.argv[2];
if (!root) throw Error('Missing CI artifact directory');
const resultRoot = join(root, 'test-results');
const name = readdirSync(resultRoot).find((s) => s.startsWith('wloc-375-390-430-768-1440p-') && s.endsWith('-iphone'));
if (!name) throw Error('Original failing iPhone evidence missing');
const dir = join(resultRoot, name);
const zip = join(dir, 'trace.zip');
const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
const events: any[] = [];
for (const entry of entries.filter((s) => s.endsWith('.trace'))) {
  const data = execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  for (const line of data.split('\n').filter(Boolean)) events.push(JSON.parse(line));
}
const starts = new Map(events.filter((e) => e.type === 'before').map((e) => [e.callId, e]));
const actions = events.filter((e) => e.type === 'after').map((e) => {
  const start = starts.get(e.callId) || {};
  const selector = String(start.params?.selector || '');
  return {
    call: start.apiName || start.method,
    durationMs: Math.round(e.endTime - (start.startTime || e.endTime)),
    viewport: start.method === 'setViewportSize' ? start.params?.viewportSize : undefined,
    target: ['切换主题', '应用坐标', '纬度', '经度'].find((s) => selector.includes(s)),
    failed: !!e.error,
  };
});
console.log('WLOC_TRACE_SUMMARY=' + JSON.stringify({ actions }));
const md = readFileSync(join(dir, 'error-context.md'), 'utf8');
console.log('WLOC_VISIBLE_CONTROLS=' + JSON.stringify(md.split('\n').filter((s) => /切换主题|应用坐标|保存到设备/.test(s)).map((s) => s.slice(0, 160))));
const frames = events.filter((e) => e.type === 'screencast-frame');
const last = frames.at(-1);
if (last) {
  const entry = 'resources/' + last.sha1;
  if (!entries.includes(entry) || !/^resources\/[a-zA-Z0-9._-]+\.(jpeg|png)$/.test(entry)) throw Error('Unexpected screenshot resource');
  const data = execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 4 * 1024 * 1024 });
  console.log('WLOC_SCREENSHOT_JSON=' + JSON.stringify({ mime: entry.endsWith('.png') ? 'image/png' : 'image/jpeg', width: last.width, height: last.height, base64: data.toString('base64') }));
}
const shots = readdirSync(join(root, 'docs/screenshots')).filter((s) => /^wloc-\d+-dark-iphone\.png$/.test(s));
console.log('WLOC_ORIGINAL_PNG_SIZES=' + JSON.stringify(shots.map((path) => ({ path, bytes: statSync(join(root, 'docs/screenshots', path)).size }))));
