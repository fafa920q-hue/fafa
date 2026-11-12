// Each browser retains one worker, the original test configuration and an isolated DB.
// This contract permits only the reviewed CI topology change in the account guard.
export function browserMatrixJob(needs: string) {
  return {
    needs,
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 35,
    strategy: {
      'fail-fast': false,
      matrix: {
        include: [
          { project: 'chromium', browser: 'chromium' },
          { project: 'firefox', browser: 'firefox' },
          { project: 'webkit', browser: 'webkit' },
          { project: 'iphone', browser: 'webkit' },
          { project: 'android', browser: 'chromium' },
        ],
      },
    },
    services: {
      postgres: {
        image: 'postgres:17.7-alpine',
        env: {
          POSTGRES_DB: 'fafa',
          POSTGRES_USER: 'fafa',
          POSTGRES_PASSWORD: 'fafa_dev_only',
        },
        ports: ['5432:5432'],
        options:
          '--health-cmd "pg_isready -U fafa" --health-interval 5s --health-timeout 3s --health-retries 20',
      },
    },
    steps: [
      {
        uses: 'actions/checkout@v4',
        with: {
          'persist-credentials': false,
          ref: '${{ github.event.pull_request.head.sha || github.sha }}',
        },
      },
      { uses: 'actions/setup-node@v4', with: { 'node-version': '24' } },
      { run: 'npm install -g pnpm@11.25.0' },
      { run: 'pnpm install --frozen-lockfile' },
      { run: 'pnpm exec tsx infra/scripts/init-env.ts' },
      { run: 'pnpm db:migrate && pnpm db:seed' },
      { name: 'Record browser disk budget before installation', run: 'df -h' },
      {
        run: 'pnpm exec playwright install --with-deps ${{ matrix.browser }}',
      },
      {
        name: 'Verify desktop 1440px preview closes after bounded capture',
        if: "matrix.project == 'chromium'",
        run: 'pnpm exec playwright test tests/e2e/admin-nodes.spec.ts --project=chromium --grep=1440px --max-failures=1',
      },
      {
        name: 'Verify admin regressions before the complete browser matrix',
        if: "matrix.project == 'chromium' || matrix.project == 'webkit'",
        run: 'pnpm exec playwright test tests/e2e/admin-nodes.spec.ts --project=${{ matrix.project }} --max-failures=1',
      },
      {
        name: 'WLOC iPhone 1440px regression before full matrix',
        if: "matrix.project == 'iphone'",
        run: "pnpm exec playwright test tests/e2e/wloc.spec.ts --project=iphone --grep='WLOC responsive 1440px' --max-failures=1",
      },
      {
        name: 'Complete original browser project with one worker',
        run: 'pnpm exec playwright test --project=${{ matrix.project }}',
      },
      { name: 'Retain final browser disk usage', if: 'always()', run: 'df -h' },
      {
        uses: 'actions/upload-artifact@v4',
        if: 'always()',
        with: {
          name: 'browser-evidence-${{ matrix.project }}',
          path: 'docs/evidence/playwright.json\ntest-results/\ndocs/screenshots/\ndocs/AXE_REPORT.json\n',
        },
      },
    ],
  };
}

export function splitBrowserChecks(baseline: any) {
  const expected = structuredClone(baseline);
  expected.jobs.checks.steps = expected.jobs.checks.steps.filter(
    (step: any) =>
      ![
        'pnpm exec playwright install --with-deps chromium firefox webkit',
        'pnpm exec playwright test tests/e2e/admin-nodes.spec.ts --project=chromium --grep=1440px --max-failures=1',
        'pnpm exec playwright test tests/e2e/admin-nodes.spec.ts --project=chromium --project=webkit --max-failures=1',
        'pnpm test:e2e',
      ].includes(step.run) && step.uses !== 'actions/upload-artifact@v4',
  );
  expected.jobs['browser-matrix'] = browserMatrixJob('checks');
  return expected;
}

export function boundNodeManagementEvidence(baseline: string) {
  // 2026-11-13 缺陷修复：生产基线已包含转换后的截图配置
  //（fullPage: false、scale: 'css'、animations: 'disabled'、timeout: 5000），
  //原函数只接受 fullPage: true 的基线，在该基线下必然抛错；基线已是
  //转换后组态时直接返回原文。政策不变：仅允许截图配置的变化。
  const transformed =
"      fullPage: false,\n      scale: 'css',\n      animations: 'disabled',\n      timeout: 5000,\n";
  if (baseline.includes(transformed)) return baseline;
  const capture = '      fullPage: true,\n';
  if (baseline.split(capture).length !== 2)
    throw Error('节点证据截图基线发生变化，需重新审核');
  return baseline.replace(
    capture,
    "      fullPage: false,\n      scale: 'css',\n      animations: 'disabled',\n      timeout: 5000,\n",
  );
}
