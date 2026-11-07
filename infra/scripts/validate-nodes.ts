import { parseBatch } from '../../packages/subscription/src';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576) throw Error('输入超过大小限制');
}
const result = parseBatch(input);
const countries: Record<string, number> = {};
const protocols: Record<string, number> = {};
for (const node of result.nodes) {
  countries[node.country || '未标注'] =
    (countries[node.country || '未标注'] || 0) + 1;
  protocols[node.protocol] = (protocols[node.protocol] || 0) + 1;
}
console.log(
  JSON.stringify(
    {
      total: result.total,
      valid: result.nodes.length,
      duplicates: result.duplicates,
      failures: result.failures,
      countries,
      protocols,
      connectivity: 'NOT_TESTED',
    },
    null,
    2,
  ),
);
