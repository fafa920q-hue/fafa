import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { parse } from 'dotenv';
import { OAuth2Client } from 'google-auth-library';
import { sql } from '../packages/db/src';
import { buildApp } from '../apps/api/src/server';
import { issueOwnerCredential, beginOwnerCredential, completeOwnerCredential } from '../packages/auth/src/owner';
import { activateGoogle } from '../packages/auth/src';
import { hash, unseal } from '../packages/shared/src/crypto';
let app: Awaited<ReturnType<typeof buildApp>>;
const testRole = 'fafa_test_' + randomBytes(6).toString('hex');
let createdTestRole=false;
const origin = 'http://localhost:5173';
beforeAll(async () => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'owner-fixture.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-only');
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  if (createdTestRole) {
    await sql`drop owned by ${sql(testRole)}`;
    await sql`drop role ${sql(testRole)}`;
  }
  await sql.end(); vi.unstubAllEnvs();
});
describe('一次性 Owner 初始化真实数据库安全边界', () => {
  it('公开登录、邮箱或旧 sub 环境变量不能自动授予 Owner', async () => {
    const nonInteractive=spawnSync('node',['--import','tsx','infra/scripts/owner-setup.ts'],{env:process.env,encoding:'utf8'});
    expect(nonInteractive.status).toBe(1);
    expect(nonInteractive.stdout).toBe('');
    vi.stubEnv('BOOTSTRAP_ADMIN_GOOGLE_SUB', 'untrusted-sub');
    await expect(activateGoogle({ sub: 'untrusted-sub', email: 'untrusted@example.invalid', email_verified: true })).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
    expect((await app.inject({ method: 'POST', url: '/auth/owner/start', headers: { origin }, payload: { credential: 'x'.repeat(80) } })).statusCode).toBe(404);
    const [count] = await sql`select count(*)::int as total from users where role='Owner'`;
    expect(count.total).toBe(0);
  });
  it('凭据仅存哈希，过期、五次错误及重签发立即失效', async () => {
    const expired = await issueOwnerCredential();
    const [row] = await sql`select * from owner_setup_credentials where id=${expired.split('.')[0]}`;
    expect(JSON.stringify(row)).not.toContain(expired);
    expect(row.token_hash).toBe(hash(expired));
    await sql`update owner_setup_credentials set expires_at=now()-interval '1 second'`;
    await expect(beginOwnerCredential(expired, 'state')).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    const limited = await issueOwnerCredential();
    for (let i=0;i<5;i++) await expect(beginOwnerCredential(limited.split('.')[0]+'.wrong', 'state')).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    await expect(beginOwnerCredential(limited, 'state')).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    const old = await issueOwnerCredential();
    await issueOwnerCredential();
    await expect(beginOwnerCredential(old, 'state')).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
  });
  it('正式 OAuth 入口检查 Origin、state、nonce、iss、aud、exp；PKCE 且凭据不进入 URL', async () => {
    const raw = await issueOwnerCredential();
    const denied = await app.inject({ method: 'POST', url: '/auth/owner/start', headers: { origin: 'https://evil.invalid' }, payload: { credential: raw } });
    expect(denied.statusCode).toBe(403);
    const begin = await app.inject({ method: 'POST', url: '/auth/owner/start', headers: { origin }, payload: { credential: raw } });
    expect(begin.statusCode).toBe(200);
    expect(begin.body).not.toContain(raw);
    const cookie = begin.cookies.find((c) => c.name==='fafa_oidc')!;
    const flow = JSON.parse(unseal(JSON.parse(Buffer.from(cookie.value, 'base64url').toString())));
    const url = new URL(begin.json().url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(Buffer.from(hash(flow.verifier),'hex').toString('base64url'));
    await expect(beginOwnerCredential(raw, flow.state)).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    const exchange = vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: { id_token: 'fixture' } } as any);
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    const payload = { sub: 'verified-fixture-sub', email: 'owner@example.invalid', email_verified: true,
      iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now()/1000)+300, nonce: flow.nonce };
    const callback = (state = flow.state) => app.inject({ url: '/auth/google/callback?state='+state+'&code=fixture', headers: { cookie: 'fafa_oidc='+cookie.value } });
    expect((await callback('wrong')).statusCode).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    for (const bad of [{ nonce: 'wrong' }, { iss: 'https://evil.invalid' }, { aud: 'wrong' }, { exp: 1 }]) {
      verify.mockResolvedValue({ getPayload: () => ({ ...payload, ...bad }) } as any);
      expect((await callback()).statusCode).toBe(403);
    }
    verify.mockRejectedValueOnce(Error('signature invalid'));
    expect((await callback()).statusCode).toBe(403);
    expect((await sql`select id from users where role='Owner'`).length).toBe(0);
    vi.restoreAllMocks();
  });
  it('错误 flow 不能绑定；并发完成只产生唯一 Owner，入口永久关闭', async () => {
    const raw = await issueOwnerCredential();
    const begin = await app.inject({ method: 'POST', url: '/auth/owner/start', headers: { origin }, payload: { credential: raw } });
    expect(begin.statusCode).toBe(200);
    const cookie = begin.cookies.find((value) => value.name==='fafa_oidc')!;
    const flow = JSON.parse(unseal(JSON.parse(Buffer.from(cookie.value,'base64url').toString())));
    const state = flow.state, id = flow.ownerCredential;
    await expect(completeOwnerCredential(id, 'wrong', { sub: 'owner-sub', email: 'owner@example.invalid', email_verified: true })).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: { id_token: 'fixture' } } as any);
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({ getPayload: () => ({
      sub: 'owner-sub', email: 'owner@example.invalid', email_verified: true,
      iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now()/1000)+300, nonce: flow.nonce,
    }) } as any);
    const callback = () => app.inject({ url: '/auth/google/callback?state='+state+'&code=fixture', headers: { cookie: 'fafa_oidc='+cookie.value } });
    const results = await Promise.all([callback(),callback()]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([302,403]);
    const session = results.find((result) => result.statusCode===302)!.cookies.find((value) => value.name==='fafa_session')!;
    expect((await app.inject({ url: '/api/admin/users', headers: { cookie: 'fafa_session='+session.value } })).statusCode).toBe(200);
    vi.restoreAllMocks();
    const [owner] = await sql`select * from users where role='Owner'`;
    expect(owner).toBeTruthy();
    const [binding] = await sql`select * from owner_initialization`;
    expect(binding.closed).toBe(true);
    expect(binding.owner_id).toBe(owner.id);
    await expect(issueOwnerCredential()).rejects.toThrow();
    expect((await app.inject('/auth/config')).json().ownerSetup).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/auth/owner/start', headers: { origin }, payload: { credential: raw } })).statusCode).toBe(404);
    await expect(sql`update owner_initialization set closed=false`).rejects.toThrow();
    await expect(sql`delete from owner_initialization`).rejects.toThrow();
    await expect(sql`update users set role='Member' where id=${owner.id}`).rejects.toThrow();
    await expect(sql`delete from users where id=${owner.id}`).rejects.toThrow();
    await expect(completeOwnerCredential(id, state, { sub: 'new-sub', email: 'new@example.invalid', email_verified: true })).rejects.toMatchObject({ code: 'OWNER_AUTHORIZATION' });
    await expect(activateGoogle({ sub: 'new-sub', email: 'new@example.invalid', email_verified: true })).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
  });
  it('生产数据库角色不能读取凭据哈希、修改绑定/审计、提升 Owner 或创建表', async () => {
    const temporary=await mkdtemp(join(tmpdir(),'fafa-runtime-role-'));
    const path=join(temporary,'runtime.env');
    try {
      expect((await sql`select rolname from pg_roles where rolname=${testRole}`).length).toBe(0);
      const prepare=spawnSync('node',['--import','tsx','infra/scripts/prepare-production-db.ts'], {
        env: { ...process.env, FAFA_RUNTIME_FILE: path, FAFA_TEST_RUNTIME_ROLE: testRole }, encoding:'utf8',
      });
      createdTestRole=(await sql`select rolname from pg_roles where rolname=${testRole}`).length>0;
      expect(prepare.status,prepare.stderr).toBe(0);
      const config=parse(await readFile(path));
      const runtime=postgres(config.DATABASE_URL,{max:1});
      try {
        expect((await runtime`select current_user as name`)[0].name).toBe(testRole);
        await expect(runtime`select * from owner_setup_credentials`).rejects.toThrow();
        await expect(runtime`update owner_initialization set closed=false`).rejects.toThrow();
        await expect(runtime`update audit_events set action='tamper'`).rejects.toThrow();
        await expect(runtime.unsafe('create table forbidden_ddl(id integer)')).rejects.toThrow();
        await expect(runtime`insert into users(email,name,role) values('forbidden@example.invalid','forbidden','Owner')`).rejects.toThrow();
        expect((await runtime`select owner_setup_available() as available`)[0].available).toBe(false);
      } finally { await runtime.end(); }
      const check=spawnSync('node',['--import','tsx','-e',
        'import("./infra/scripts/check-runtime-db.ts").then(m=>m.assertRuntimeDatabaseRole(' + JSON.stringify(testRole) + ')).then(()=>import("./packages/db/src/index.ts")).then(m=>m.sql.end())'], {
          env:{...process.env,NODE_ENV:'production',DATABASE_URL:config.DATABASE_URL}, encoding:'utf8',
        });
      expect(check.status,check.stderr).toBe(0);
      const before=(await readFile(path)).toString();
      const again=spawnSync('node',['--import','tsx','infra/scripts/prepare-production-db.ts'],{
        env:{...process.env,FAFA_RUNTIME_FILE:path,FAFA_TEST_RUNTIME_ROLE:testRole}, encoding:'utf8',
      });
      expect(again.status,again.stderr).toBe(0);
      expect((await readFile(path)).toString()).toBe(before);
    } finally {
      await rm(temporary,{recursive:true,force:true});
    }
  });

});
