import { createInterface } from 'node:readline';
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';

const root = '/workspace';
const maxBytes = 64 * 1024;
let writes = 0;
const editable = (part) =>
  part &&
  !part.startsWith('.') &&
  !/[\\\u0000-\u001f]/u.test(part) &&
  part.length <= 200;
const forbidden = (part) => /\.(pem|key|p12)$/i.test(part);
const relative = (name) => {
  if (typeof name !== 'string' || name.length > 600)
    throw Error('invalid path');
  const parts = name.split('/');
  if (!parts.every((part) => editable(part) && !forbidden(part)))
    throw Error('path not allowed');
  return parts;
};

async function filePath(name, create) {
  const parts = relative(name);
  let cursor = root;
  for (const [i, part] of parts.entries()) {
    cursor = join(cursor, part);
    const last = i === parts.length - 1;
    const entry = await lstat(cursor).catch((error) => {
      if (error.code !== 'ENOENT' || !create) throw error;
      return null;
    });
    if (entry && (last ? !entry.isFile() : !entry.isDirectory()))
      throw Error('path not regular');
    if (!entry && !last) await mkdir(cursor);
  }
  return cursor;
}
async function tree(dir = root, prefix = '', found = [], depth = 0) {
  if (depth > 20) return found;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (found.length >= 500) break;
    if (!editable(entry.name) || forbidden(entry.name)) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      await tree(resolve(dir, entry.name), name + '/', found, depth + 1);
    else if (entry.isFile()) found.push(name);
  }
  return found;
}
const pathSchema = { type: 'string', maxLength: 600 };
const textSchema = { type: 'string', maxLength: maxBytes };
const tool = (name, description, properties) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});
const tools = [
  tool('list_files', 'List files within the isolated checkout.', {}),
  tool('read_file', 'Read a UTF-8 project file from the isolated checkout.', {
    path: pathSchema,
  }),
  tool(
    'write_file',
    'Replace or create a UTF-8 project file in the isolated checkout.',
    { path: pathSchema, text: textSchema },
  ),
];
async function call(name, args) {
  if (name === 'list_files') return (await tree()).join('\n');
  if (name === 'read_file') {
    const path = await filePath(args.path, false);
    if ((await lstat(path)).size > maxBytes) throw Error('file size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(path),
    );
  }
  if (name === 'write_file') {
    if (
      ++writes > 30 ||
      typeof args.text !== 'string' ||
      Buffer.byteLength(args.text) > maxBytes ||
      args.text.includes(String.fromCharCode(0))
    )
      throw Error('write limit');
    const path = await filePath(args.path, true);
    const temp = join(dirname(path), '.fafa-' + randomUUID());
    try {
      await writeFile(temp, args.text, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    return 'Saved ' + args.path;
  }
  throw Error('tool not allowed');
}

for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let req;
  try {
    if (line.length > maxBytes * 8) continue;
    req = JSON.parse(line);
    if (req.id === undefined) continue;
    let result;
    if (req.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workspace', version: '1.0.0' },
      };
    else if (req.method === 'ping') result = {};
    else if (req.method === 'tools/list') result = { tools };
    else if (req.method === 'tools/call') {
      try {
        result = {
          content: [
            {
              type: 'text',
              text: await call(req.params.name, req.params.arguments ?? {}),
            },
          ],
        };
      } catch {
        result = {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Workspace operation refused or file unavailable.',
            },
          ],
        };
      }
    } else throw Error('unsupported');
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n',
    );
  } catch {
    if (req?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: 'Unsupported workspace request.' },
        }) + '\n',
      );
  }
}
