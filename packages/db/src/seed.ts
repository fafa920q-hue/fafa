import { sql } from './index';
import { mockEnabled } from '../../auth/src';
if (!mockEnabled() || process.env.DEMO_MODE !== 'true')
  throw Error('seed 仅允许显式开发演示环境');
for (const [id, name, role] of [
  ['11111111-1111-4111-8111-111111111111', '演示管理员', 'Owner'],
  ['22222222-2222-4222-8222-222222222222', '演示成员', 'Member'],
  ['33333333-3333-4333-8333-333333333333', '演示访客', 'Viewer'],
]) {
  await sql`insert into users(id,email,name,role) values(${id},${role.toLowerCase() + '@example.invalid'},${name},${role}) on conflict(id) do nothing`;
}
const owner = '11111111-1111-4111-8111-111111111111';
if (!(await sql`select id from node_sources where owner_id=${owner}`).length) {
  for (const [name, country] of [
    ['东京 · 开发样例', '日本'],
    ['新加坡 · 开发样例', '新加坡'],
    ['洛杉矶 · 开发样例', '美国'],
    ['香港 · 开发样例', '香港'],
    ['伦敦 · 开发样例', '英国'],
    ['法兰克福 · 开发样例', '德国'],
  ]) {
    await sql`insert into node_sources(owner_id,data) values(${owner},${sql.json({ name, country, kind: 'OWNED_NODE', enabled: true, demo: true, status: 'DEMO', nodeCount: 0 })})`;
  }
  await sql`insert into ai_accounts(owner_id,data) values(${owner},${sql.json({ name: '主用 · 待配置', status: 'UNCONFIGURED', demo: true })})`;
  await sql`insert into server_connections(owner_id,data) values(${owner},${sql.json({ name: '开发服务器 · 样例', host: 'server.example.invalid', port: 22, username: 'deploy', country: '未标注', status: 'UNKNOWN', demo: true })})`;
  await sql`insert into location_presets(owner_id,data) values(${owner},${sql.json({ name: '东京', latitude: 35.6762, longitude: 139.6503, country: '日本', demo: true })})`;
}
await sql.end();
console.log('非敏感演示数据就绪（不会连接外部服务）');
