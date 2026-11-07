import type { BrowserContext, Page, Request } from '@playwright/test';

const domains = new Set(['fafa888.uk', 'a.fafa888.uk']);
const paths = new Set([
  '/',
  '/api/me',
  '/api/admin/users',
  '/api/summary',
  '/api/ready',
  '/api/node_sources',
  '/api/location_presets',
  '/api/subscription/rotate',
  '/auth/config',
  '/auth/dev',
  '/servers',
  '/locations',
]);
export function safeEndpoint(value: string) {
  try {
    const url = new URL(value);
    return {
      origin: domains.has(url.hostname) ? url.origin : 'OTHER_ORIGIN',
      path: paths.has(url.pathname) ? url.pathname : 'REDACTED_PATH',
    };
  } catch {
    return { origin: 'INVALID_URL', path: 'REDACTED_PATH' };
  }
}
export function errorCategory(message: string) {
  return {
    category: /local network|private network|address space|loopback/i.test(
      message,
    )
      ? 'LOCAL_NETWORK'
      : /CORS|access.control/i.test(message)
        ? 'CORS'
        : /certificate|CERT_/i.test(message)
          ? 'CERTIFICATE'
          : /Content Security Policy/i.test(message)
            ? 'CSP'
            : /Mixed Content/i.test(message)
              ? 'MIXED_CONTENT'
              : 'BROWSER_ERROR',
    networkCode: message.match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0] || null,
  };
}
export function corsHeaders(headers: Record<string, string>) {
  const get = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const origin = get('access-control-allow-origin');
  return {
    allowOrigin: origin ? safeEndpoint(origin).origin : null,
    allowCredentials: get('access-control-allow-credentials') === 'true',
    allowMethods: get('access-control-allow-methods') || null,
    allowsCsrfHeader: /x-csrf-token/i.test(
      get('access-control-allow-headers') || '',
    ),
  };
}
export async function createTlsDiagnostics(
  page: Page,
  context: BrowserContext,
) {
  const events: Record<string, unknown>[] = [];
  const pending: Promise<unknown>[] = [];
  const requests = new Map<string, ReturnType<typeof safeEndpoint>>();
  const add = (kind: string, value: Record<string, unknown>) => {
    if (events.length < 250) events.push({ kind, ...value });
  };
  const relevant = (request: Request) => {
    const url = new URL(request.url());
    return (
      domains.has(url.hostname) &&
      (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/auth/') ||
        request.isNavigationRequest())
    );
  };
  page.on('request', (request) => {
    if (!relevant(request)) return;
    pending.push(
      request.allHeaders().then((headers) => {
        const origin = headers.origin;
        add('request', {
          ...safeEndpoint(request.url()),
          method: request.method(),
          origin: origin ? safeEndpoint(origin).origin : null,
          cookieSent: !!headers.cookie,
          hasCsrfHeader: !!headers['x-csrf-token'],
          redirectFrom: request.redirectedFrom()
            ? safeEndpoint(request.redirectedFrom()!.url())
            : null,
        });
      }),
    );
  });
  page.on('requestfailed', (request) => {
    if (relevant(request))
      add('requestfailed', {
        ...safeEndpoint(request.url()),
        method: request.method(),
        ...errorCategory(request.failure()?.errorText || ''),
      });
  });
  page.on('response', (response) => {
    if (!relevant(response.request())) return;
    pending.push(
      (async () => {
        const headers = await response.allHeaders();
        const security = await response.securityDetails();
        add('response', {
          ...safeEndpoint(response.url()),
          method: response.request().method(),
          status: response.status(),
          ...corsHeaders(headers),
          location: headers.location
            ? safeEndpoint(new URL(headers.location, response.url()).href)
            : null,
          server: await response.serverAddr(),
          tls: security
            ? {
                issuer: security.issuer,
                subjectName: security.subjectName,
                validFrom: security.validFrom,
                validTo: security.validTo,
                protocol: security.protocol,
              }
            : null,
        });
      })(),
    );
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      add('console-error', errorCategory(message.text()));
  });
  page.on('pageerror', (error) =>
    add('pageerror', errorCategory(error.message)),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (event) => {
    requests.set(event.requestId, safeEndpoint(event.request.url));
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
    add('cdp-request-extra', {
      endpoint: requests.get(event.requestId),
      cookieSent: Object.keys(event.headers).some(
        (key) => key.toLowerCase() === 'cookie',
      ),
      cookieBlockedReasons: event.associatedCookies.flatMap(
        (cookie) => cookie.blockedReasons,
      ),
      initiatorAddressSpace: event.clientSecurityState?.initiatorIPAddressSpace,
      secureContext: event.clientSecurityState?.initiatorIsSecureContext,
    });
  });
  cdp.on('Network.loadingFailed', (event) =>
    add('cdp-loading-failed', {
      endpoint: requests.get(event.requestId),
      ...errorCategory(event.errorText),
      blockedReason: event.blockedReason || null,
      corsError: event.corsErrorStatus?.corsError || null,
    }),
  );
  return {
    add,
    async snapshot() {
      await Promise.allSettled(pending);
      const cookies = await context.cookies('https://fafa888.uk');
      const session = cookies.find((cookie) => cookie.name === 'fafa_session');
      return {
        scope:
          'Isolated CI only; no cookie values, tokens, bodies or query strings recorded',
        domainMappings: {
          'fafa888.uk': '127.0.0.1',
          'a.fafa888.uk': '127.0.0.1',
        },
        proxy: 'DIRECT',
        browserCertificateMode:
          'temporary internal CA; browser ignoreHTTPSErrors; Node verifies chain and SNI',
        sessionCookie: session
          ? {
              present: true,
              domain: session.domain,
              path: session.path,
              secure: session.secure,
              httpOnly: session.httpOnly,
              sameSite: session.sameSite,
            }
          : { present: false },
        events,
      };
    },
  };
}
