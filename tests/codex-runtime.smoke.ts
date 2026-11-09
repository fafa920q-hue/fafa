import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBroker } from '../apps/codex-worker/src/broker';
import {
  createContainer,
  destroyContainer,
  docker,
  runContainer,
  verifyRuntime,
} from '../apps/codex-worker/src/sandbox';

const runtime = await verifyRuntime();
const root = await mkdtemp(join(tmpdir(), 'fafa-native-smoke-'));
const workspace = join(root, 'workspace');
const socket = join(root, 'broker.sock');
await mkdir(workspace);
await writeFile(
  join(workspace, 'greeting.cjs'),
  'module.exports = "before";\n',
);
await writeFile(
  join(workspace, 'greeting.test.cjs'),
  `const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('file was edited by Codex workspace tool',()=>assert.equal(require('./greeting.cjs'),'after'));
test('test sandbox excludes broker and disallows workspace writes',()=>{
  assert.equal(fs.existsSync('/model.sock'),false);
  assert.throws(()=>fs.writeFileSync('/workspace/unauthorized','x'));
});`,
);
const model = 'gpt-4.1-mini';
const rate = { context: 32768, input: 400000, cached: 100000, output: 1600000 };
let calls = 0;
const controller = new AbortController();
let id = '';
const fake = {
  inputTokens: { count: async () => ({ input_tokens: 500 }) },
  async *create(d: any) {
    calls++;
    assert.equal(d.model, model);
    assert.equal(d.store, false);
    assert.deepEqual(d.tools.map((t: any) => t.name).sort(), [
      'mcp__workspace__list_files',
      'mcp__workspace__read_file',
      'mcp__workspace__write_file',
    ]);
    const input = JSON.stringify(d.input);
    if (calls === 2) assert.match(input, /Workspace operation refused/);
    if (calls === 3) assert.match(input, /before/);
    if (calls === 4) assert.match(input, /Saved greeting\.cjs/);
    const id = 'resp_fixture_' + calls;
    const response = {
      id,
      object: 'response',
      created_at: 1700000000,
      status: 'in_progress',
      model,
      output: [],
    };
    yield { type: 'response.created', response };
    const args =
      calls === 1
        ? { path: '../../etc/passwd' }
        : calls === 2
          ? { path: 'greeting.cjs' }
          : { path: 'greeting.cjs', text: 'module.exports = "after";\n' };
    const item =
      calls <= 3
        ? {
            type: 'function_call',
            id: 'fc_fixture_' + calls,
            call_id: 'call_fixture_' + calls,
            name:
              calls === 3
                ? 'mcp__workspace__write_file'
                : 'mcp__workspace__read_file',
            arguments: JSON.stringify(args),
            status: 'completed',
          }
        : {
            type: 'message',
            id: 'msg_fixture',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Fixture edit completed.',
                annotations: [],
              },
            ],
          };
    yield { type: 'response.output_item.added', output_index: 0, item };
    yield { type: 'response.output_item.done', output_index: 0, item };
    yield {
      type: 'response.completed',
      response: {
        ...response,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 500,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 530,
        },
      },
    };
  },
};
const broker = await openBroker({
  socket,
  model,
  rate,
  maxOutput: 2000,
  signal: controller.signal,
  responses: fake as any,
  beforeRequest: async () => true,
  beforeBillable: async () => true,
  providerError: async () => {
    throw Error('unexpected provider error');
  },
});
try {
  id = await createContainer({
    workspace,
    name: runtime.namespace + '-smoke-codex',
    recipe: 'CODEX',
    socket,
    model,
    context: rate.context,
  });
  let output = '';
  const code = await runContainer(
    id,
    'Read greeting.cjs, change it to after and summarize.',
    AbortSignal.timeout(120_000),
    (chunk) => {
      output += chunk;
    },
  );
  if (code !== 0) console.log(output.slice(-3500));
  assert.equal(code, 0);
  assert.equal(calls, 4);
  assert.match(
    await readFile(join(workspace, 'greeting.cjs'), 'utf8'),
    /"after"/,
  );
  await destroyContainer(id);
  id = await createContainer({
    workspace,
    name: runtime.namespace + '-smoke-test',
    recipe: 'NODE_TEST',
  });
  let tests = '';
  const testCode = await runContainer(
    id,
    '',
    AbortSignal.timeout(45_000),
    (chunk) => {
      tests += chunk;
    },
  );
  assert.equal(testCode, 0, tests);
  assert.match(tests, /# pass 2/);
  const result = await broker.close();
  assert.equal(result.started, 4);
  assert.equal(result.settled, 4);
  console.log(
    'Official Codex CLI file reads and writes, traversal denial, isolated Node tests and usage aggregation PASS (fixture model stream)',
  );
} finally {
  controller.abort();
  await destroyContainer(id);
  await broker.close();
  await rm(root, { recursive: true, force: true });
}
