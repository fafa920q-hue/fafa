if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('只能在服务器交互终端生成授权凭据，禁止输出到 CI/SSM Run Command 日志');
  process.exit(1);
}
try {
  const { issueOwnerCredential } = await import('../../packages/auth/src/owner');
  const { sql } = await import('../../packages/db/src');
  try {
    const raw = await issueOwnerCredential();
    console.log('在 https://fafa888.uk 登录页展开首次 Owner 初始化，输入以下一次性凭据。');
    console.log('15 分钟有效，最多 5 次尝试，一次 Google 授权流程；不要截图或转发。');
    console.log(raw);
  } finally { await sql.end(); }
} catch {
  console.error('Owner 授权生成失败或已永久关闭，未输出凭据或数据库配置。');
  process.exitCode=1;
}
