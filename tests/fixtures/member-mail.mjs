// CI-only outbound transport fixture. Excluded from every production Docker build.
import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
if (process.env.FAFA_TEST_MAIL_FILE) {
  const db = new URL(process.env.DATABASE_URL || '');
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.NODE_ENV !== 'development' ||
    process.env.DEMO_MODE !== 'true' ||
    !['localhost', '127.0.0.1'].includes(db.hostname) ||
    process.env.MAIL_API_KEY !== 'synthetic-browser-resend-fixture'
  )
    throw Error('Mail fixture is restricted to disposable CI');
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
    return new Response('{}', {
      status: mail.to.some((to) => to.startsWith('fail_')) ? 503 : 200,
    });
  };
}
