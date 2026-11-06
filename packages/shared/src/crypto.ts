import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function master(keyId = process.env.ENCRYPTION_KEY_ID || 'v1') {
  const current = process.env.ENCRYPTION_KEY_ID || 'v1';
  const previous = JSON.parse(
    process.env.ENCRYPTION_PREVIOUS_KEYS_JSON || '{}',
  );
  const raw = keyId === current ? process.env.ENCRYPTION_KEY : previous[keyId];
  const key = Buffer.from(raw || '', 'base64');
  if (key.length !== 32) throw new Error('请配置 32 字节 ENCRYPTION_KEY');
  return key;
}
function enc(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return {
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
function dec(v: ReturnType<typeof enc>, key: Buffer) {
  const c = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
  c.setAuthTag(Buffer.from(v.tag, 'base64'));
  return Buffer.concat([
    c.update(Buffer.from(v.ciphertext, 'base64')),
    c.final(),
  ]).toString('utf8');
}
export function seal(value: string) {
  const dek = randomBytes(32);
  return {
    keyId: process.env.ENCRYPTION_KEY_ID || 'v1',
    wrappedKey: enc(dek.toString('base64'), master()),
    value: enc(value, dek),
  };
}
export function unseal(v: ReturnType<typeof seal>) {
  return dec(
    v.value,
    Buffer.from(dec(v.wrappedKey, master(v.keyId)), 'base64'),
  );
}
