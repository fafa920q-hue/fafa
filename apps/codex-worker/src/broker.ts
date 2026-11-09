import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import {
  platformCost,
  platformReserve,
  type PlatformRate,
} from '../../../packages/shared/src/platform-ai';
import { codexCalls } from '../../../packages/auth/src/codex-execution';

type Options = {
  socket: string;
  model: string;
  rate: PlatformRate;
  maxOutput: number;
  responses: OpenAI['responses'];
  beforeRequest: () => Promise<boolean>;
  beforeBillable: () => Promise<boolean>;
  providerError: (error: unknown) => Promise<void>;
  signal: AbortSignal;
};

const allowedTools = new Set([
  'mcp__workspace__list_files',
  'mcp__workspace__read_file',
  'mcp__workspace__write_file',
]);
const maxBody = 2 * 1024 * 1024;
async function body(req: IncomingMessage) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw Error('payload limit');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function fail(res: ServerResponse, status: number, code: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: code, type: code } }));
}
export async function openBroker(options: Options) {
  let attempts = 0;
  let started = 0;
  let settled = 0;
  let active = false;
  let overrun = false;
  let input = 0,
    output = 0,
    cached = 0,
    written = 0,
    micros = 0;
  const shutdown = new AbortController();
  const requests = new Set<Promise<void>>();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: options.model, object: 'model', owned_by: 'openai' }],
        }),
      );
      return;
    }
    if (req.method !== 'POST' || path !== '/v1/responses')
      return fail(res, 404, 'ROUTE_DISABLED');
    if (active || attempts >= codexCalls || overrun)
      return fail(res, 429, 'TASK_REQUEST_LIMIT');
    active = true;
    attempts++;
    const disconnected = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) disconnected.abort();
    });
    const signal = AbortSignal.any([
      disconnected.signal,
      options.signal,
      shutdown.signal,
    ]);
    try {
      const d = await body(req);
      if (
        d.model !== options.model ||
        !Array.isArray(d.input) ||
        d.previous_response_id ||
        d.conversation ||
        !(await options.beforeRequest())
      )
        return fail(res, 403, 'TASK_SCOPE');
      const tools = Array.isArray(d.tools)
        ? d.tools.filter(
            (t: any) => t.type === 'function' && allowedTools.has(t.name),
          )
        : [];
      if (!tools.length) return fail(res, 400, 'WORKSPACE_TOOLS_UNAVAILABLE');
      const parameters = {
        model: options.model,
        input: d.input,
        instructions:
          typeof d.instructions === 'string' ? d.instructions : undefined,
        tools,
        parallel_tool_calls: false,
      };
      const counted = await options.responses.inputTokens.count(parameters, {
        signal,
      });
      if (
        !Number.isInteger(counted.input_tokens) ||
        counted.input_tokens > options.rate.context ||
        !(await options.beforeBillable()) ||
        signal.aborted
      )
        return fail(res, 403, 'TASK_INPUT_OR_ACCESS_LIMIT');
      started++;
      const stream = await options.responses.create(
        {
          ...parameters,
          reasoning: d.reasoning,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: options.maxOutput,
          store: false,
          stream: true,
          service_tier: 'default',
        },
        { signal },
      );
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      let captured = false;
      let responseBytes = 0;
      for await (const event of stream) {
        if (
          !captured &&
          (event.type === 'response.completed' ||
            event.type === 'response.incomplete' ||
            event.type === 'response.failed')
        ) {
          const usage = event.response.usage;
          if (usage) {
            const i = usage.input_tokens;
            const o = usage.output_tokens;
            const c = usage.input_tokens_details.cached_tokens;
            const w = usage.input_tokens_details.cache_write_tokens ?? 0;
            if (
              [i, o, c, w].every(
                (x) => Number.isSafeInteger(x) && x >= 0 && x <= 2_147_483_647,
              ) &&
              c + w <= i
            ) {
              const cost = platformCost(options.rate, i, c, o, w);
              if (cost > platformReserve(options.rate, options.maxOutput))
                overrun = true;
              input += i;
              output += o;
              cached += c;
              written += w;
              micros += cost;
              captured = true;
              settled++;
            }
          }
        }
        const line =
          'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
        responseBytes += Buffer.byteLength(line);
        if (responseBytes > maxBody) throw Error('response limit');
        if (!res.write(line)) await once(res, 'drain', { signal });
      }
      res.end();
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        await options.providerError(error).catch(() => {});
        fail(
          res,
          error.status && error.status < 500 ? error.status : 502,
          'UPSTREAM_REQUEST_FAILED',
        );
      } else {
        fail(res, 502, 'TASK_REQUEST_FAILED');
      }
    } finally {
      active = false;
    }
  }
  const server = createServer((req, res) => {
    const pending = handle(req, res).catch(() =>
      fail(res, 500, 'BROKER_ERROR'),
    );
    requests.add(pending);
    void pending.finally(() => requests.delete(pending));
  });
  server.requestTimeout = 60_000;
  server.listen(options.socket);
  await once(server, 'listening');
  return {
    async close() {
      shutdown.abort();
      server.closeAllConnections();
      server.close();
      await Promise.allSettled(requests);
      return {
        started,
        settled,
        input,
        output,
        cached,
        written,
        micros,
        overrun,
      };
    },
  };
}
