import 'dotenv/config';
import { sql } from '../../../packages/db/src';
import { tick } from './jobs';
import { assertEnvironment } from '../../../packages/auth/src';
assertEnvironment();
console.log('FAFA ONE Worker 已启动');
async function heartbeat() {
  await sql`insert into settings(key,value) values('worker_heartbeat',${sql.json(new Date().toISOString())}) on conflict(key) do update set value=excluded.value,updated_at=now()`;
}
await heartbeat();
const heartbeatTimer = setInterval(() => {
  void heartbeat().catch(() => {});
}, 10000);
heartbeatTimer.unref();
let running = true;
process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));
while (running) {
  try {
    await sql`update background_jobs set data=data || '{"status":"QUEUED"}',updated_at=now() where data->>'status'='RUNNING' and updated_at<now()-interval '5 minutes'`;
    await sql`update ai_tasks set data=data || '{"status":"TIMEOUT"}',updated_at=now() where data->>'status'='RUNNING' and updated_at<now()-interval '5 minutes'`;
    await tick();
  } catch {
    console.error('后台任务暂时失败，将重试（未记录凭据或上游响应）');
  }
  await new Promise((r) => setTimeout(r, 2000));
}
clearInterval(heartbeatTimer);
await sql.end();
