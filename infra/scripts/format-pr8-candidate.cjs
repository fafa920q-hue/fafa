const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const files = JSON.parse(fs.readFileSync('infra/diagnostics/pr8-candidate-files.json', 'utf8'));
for (const [name, source] of Object.entries(files)) {
  const content = cp.execFileSync('pnpm', ['exec', 'prettier', '--stdin-filepath', name], { input: source, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  console.log('PR8_FORMAT_JSON=' + JSON.stringify({path:name, content}));
  if (name === 'tests/e2e/wloc.spec.ts') fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'pr8-wloc-fixed.spec.ts'), content);
}
