import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/server';
import { sql } from '../packages/db/src';
import { createSession } from '../packages/auth/src';
vi.mock('../apps/api/src/location-tools', async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    registerLocationTools: (app: any) =>
      actual.registerLocationTools(
        app,
        actual.locationTools(async () => ({
          status: 200,
          body: JSON.stringify({
            features: [
              {
                geometry: { type: 'Point', coordinates: [2.35, 48.85] },
                properties: { name: 'Paris' },
              },
            ],
          }),
        })),
      ),
  };
});
let app: Awaited<ReturnType<typeof buildApp>>;
const ids = [randomUUID(), randomUUID(), randomUUID()];
const sessions: any[] = [];
const send = (
  i: number,
  url: string,
  method: any = 'GET',
  payload?: any,
  extra = {},
) =>
  app.inject({
    url,
    method,
    headers: {
      origin: 'http://localhost:5173',
      cookie: 'fafa_session=' + sessions[i].raw,
      'x-csrf-token': sessions[i].csrf,
      ...extra,
    },
    ...(payload ? { payload } : {}),
  });
beforeAll(async () => {
  app = await buildApp();
  for (const [i, role] of ['Member', 'Member', 'Viewer'].entries()) {
    const [user] =
      await sql`insert into users(id,email,name,role) values(${ids[i]},${ids[i] + '@example.invalid'},'WLOC fixture',${role}) returning *`;
    sessions.push(await createSession(user as any));
  }
});
afterAll(async () => {
  await sql`update users set deleted_at=now() where id in ${sql(ids)}`;
  await app.close();
  await sql.end();
});
it('requires authenticated search, allows Viewer read, returns bounded provider results', async () => {
  expect(
    (await app.inject('/api/location-tools/search?q=Paris')).statusCode,
  ).toBe(401);
  const result = await send(2, '/api/location-tools/search?q=Paris');
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35 }],
  });
  expect((await send(0, '/api/location-tools/search?q=x')).statusCode).toBe(
    400,
  );
  expect(
    (
      await send(
        0,
        '/api/location-tools/resolve?url=' +
          encodeURIComponent('https://169.254.169.254/'),
      )
    ).statusCode,
  ).toBe(400);
});
it('persists explicit CRS favorites, preserves legacy rows and prevents cross-account modification', async () => {
  const payload = {
    name: 'Paris fixture',
    latitude: 48.85,
    longitude: 2.35,
    coordinateSystem: 'WGS84',
  };
  const created = await send(0, '/api/location_presets', 'POST', payload);
  expect(created.statusCode).toBe(200);
  const id = created.json().id;
  const [row] = await sql`select data from location_presets where id=${id}`;
  expect(row.data).toMatchObject(payload);
  expect(
    (await send(1, '/api/location_presets'))
      .json()
      .some((r: any) => r.id === id),
  ).toBe(false);
  expect(
    (await send(1, '/api/location_presets/' + id, 'DELETE')).statusCode,
  ).toBe(404);
  expect(
    (await send(2, '/api/location_presets', 'POST', payload)).statusCode,
  ).toBe(403);
  expect(
    (
      await send(0, '/api/location_presets', 'POST', payload, {
        'x-csrf-token': 'invalid',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await send(0, '/api/location_presets', 'POST', payload, {
        origin: 'https://evil.invalid',
      })
    ).statusCode,
  ).toBe(403);
  const legacy = await send(0, '/api/location_presets', 'POST', {
    name: 'legacy',
    latitude: 1,
    longitude: 2,
  });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json().coordinateSystem).toBeUndefined();
  expect(
    (await send(0, '/api/location_presets/' + id, 'DELETE')).statusCode,
  ).toBe(200);
  expect((await send(0, '/api/admin/users')).statusCode).toBe(403);
});
