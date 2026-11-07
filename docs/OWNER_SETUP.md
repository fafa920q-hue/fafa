# 首次 Owner 绑定

使用现有 Google Web OAuth 客户端，不需要 Playground，不需要手工查询或粘贴 Google sub。继续使用 https://fafa888.uk/auth/google/callback；现有数据库密码、加密主密钥和 Google Secret 均不重新生成。

## 唯一的首次操作

在已上线服务器的受信交互终端（/opt/fafa-one）执行：

```bash
bash infra/scripts/production-compose.sh run --rm --no-deps -it ops node --import tsx infra/scripts/owner-setup.ts
```

该命令只创建一条授权哈希记录，不执行迁移，不修改现有密钥。工具容器使用 none 日志驱动，且拒绝非交互输出，不能放进 GitHub Actions、SSM Run Command、日志采集或录屏会话；使用既有受信终端，保管一次性输出。

在 iPhone/PC 打开 https://fafa888.uk，刷新登录页，展开「首次 Owner 初始化」，输入本地产生的授权凭据，然后使用正式 Google 登录。所有凭据通过 HTTPS POST 发送，不放入 URL、截图或 localStorage；无需知道 sub。Google 页面仍由 Google 负责，不接触 Google 密码。

15 分钟内有效，最多 5 次尝试，只能启动一次 OAuth 流程。开始即消耗凭据并绑定 state 哈希；中断或过期时只允许本地重签发，旧流程立即失效。成功回调由官方 SDK 校验签名与 Google iss/aud/exp，并校验 state、nonce 和 PKCE，取得经过验证的 sub。

## 永久关闭与权限

003_owner_setup.sql 保存不可重新打开的单例绑定，约束唯一有效 Owner；绑定的用户和 Google 身份使用外键及保护触发器。并发回调只有一个成功，其余失败；删除/修改绑定、停用或删除已绑定 Owner 会失败。管理员邀请只能指定 Admin/Member/Viewer，不能授予 Owner。

旧 BOOTSTRAP_ADMIN_GOOGLE_SUB 不再作为授予 Owner 的入口。已有已验证 Owner 的部署会在迁移时关闭初始化；既有无 Google 身份的 Owner 也不会被新登录者接管，应由运维核验，不能自动重置。初始化功能不是 Owner 转移或灾难恢复入口。

API/Worker 的 fafa_app 角色不能读授权凭据哈希、重置绑定、创建表或篡改审计；只能调用受限制的安全函数。数据库超级用户和服务器 root 属于受信运维边界，不能把对抗超级用户篡改作为本机制的保证。

## 验收

测试包括过期、限次、旧凭据撤销、Origin、state/nonce/iss/aud/exp、SDK 签名拒绝、PKCE、并发回调、永久关闭、旧 sub 绕过拒绝，以及真实 PostgreSQL 权限隔离。Google SDK 在自动测试中使用 fixture；真实 Google 登录和最终 Owner 的选择必须由拥有该账户的人在正式网站完成，不能用测试身份冒充。
