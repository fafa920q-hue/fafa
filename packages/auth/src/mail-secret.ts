import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

// A production Compose secret is mounted into the API only. Never copy it to env.
export function mailApiKey(): string {
  const path = process.env.MAIL_API_KEY_FILE;
  if (!path) return process.env.MAIL_API_KEY?.trim() || '';
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > 4096 ||
      (info.mode & 0o077) !== 0 ||
      ![0, process.getuid?.()].includes(info.uid)
    )
      return '';
    const value = readFileSync(fd, 'utf8').trim();
    return /^\S{16,4096}$/.test(value) ? value : '';
  } catch {
    // A configured file failing validation never falls back to an environment key.
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
