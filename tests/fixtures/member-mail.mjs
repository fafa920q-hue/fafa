import process from 'node:process';
import { URL } from 'node:url';
// Disposable test transport, excluded from every production Docker build.
import { appendFileSync, existsSync } from 'node:fs';
const original = globalThis.fetch;
if (process.env.FAFA_TEST_MAIL_FILE) {
  const db = new URL(process.env.DATABASE_URL || '');
  const localDocker =
    process.env.FAFA_LOCAL_MAIL_FIXTURE === 'disposable-docker' &&
    existsSync('/.dockerenv') &&
    /^\/fafa_member_browser_[a-f0-9]{12}_test$/.test(db.pathname) &&
    process.env.FAFA_TEST_MAIL_FILE.startsWith('/tmp/');
  if (
    (process.env.GITHUB_ACTIONS !== 'true' && !localDocker) ||
    process.env.NODE_ENV !== 'development' ||
    process.env.DEMO_MODE !== 'true' ||
    !['localhost', '127.0.0.1'].includes(db.hostname) ||
    process.env.MAIL_API_KEY !== 'synthetic-browser-resend-fixture'
  )
    throw Error(
      'Mail fixture requires disposable CI or explicit isolated local Docker',
    );
  globalThis.fetch = async (input, options) => {
    if (String(input) !== 'https://api.resend.com/emails')
      return original(input, options);
    const mail = JSON.parse(String(options.body));
    if (!mail.to.every((to) => to.endsWith('@example.invalid')))
      throw Error('Synthetic recipients required');
    appendFileSync(
      process.env.FAFA_TEST_MAIL_FILE,
      JSON.stringify(mail) + '\n',
      { mode: 0o600 },
    );
    return new globalThis.Response('{}', {
      status: mail.to.some((to) => to.startsWith('fail_')) ? 503 : 200,
    });
  };
}
