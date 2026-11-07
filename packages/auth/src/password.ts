import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/src';

const options = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };
let inFlight = 0;
let dummy: Promise<string> | undefined;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (inFlight >= 4)
    throw new AppError(429, 'AUTH_BUSY', '认证请求较多，请稍后重试');
  inFlight++;
  return new Promise((resolve, reject) => {
    try {
      argon2(
        'argon2id',
        { ...options, message: password, nonce: salt },
        (error, key) => {
          inFlight--;
          if (error)
            reject(
              new AppError(503, 'PASSWORD_UNAVAILABLE', '密码认证暂不可用'),
            );
          else resolve(key);
        },
      );
    } catch {
      inFlight--;
      reject(new AppError(503, 'PASSWORD_UNAVAILABLE', '密码认证暂不可用'));
    }
  });
}
export function validatePassword(password: string) {
  if (
    [...password].length < 15 ||
    [...password].length > 128 ||
    Buffer.byteLength(password) > 512
  )
    throw new AppError(
      400,
      'PASSWORD_POLICY',
      '密码须为15至128个字符，可使用空格和中文',
    );
}
export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return (
    '$argon2id$v=19$m=65536,t=3,p=1$' +
    salt.toString('base64') +
    '$' +
    digest.toString('base64')
  );
}
export async function verifyPassword(password: string, encoded?: string) {
  if (!encoded) {
    dummy ||= hashPassword('fictional-dummy-password-for-timing');
    await verifyPassword(password, await dummy);
    return false;
  }
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts[1] !== 'argon2id' ||
    parts[2] !== 'v=19' ||
    parts[3] !== 'm=65536,t=3,p=1'
  )
    return verifyPassword(password);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length !== 16 || expected.length !== 32)
    return verifyPassword(password);
  const actual = await derive(password, salt);
  return timingSafeEqual(expected, actual);
}
