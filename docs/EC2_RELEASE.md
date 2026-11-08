# EC2 直接发布

源码使用既有 feat/member-auth-delivery，固定经过服务器测试的完整 Git SHA。GitHub 仅提供源码，不把 Actions 付款状态作为发布条件。

生产根目录及未跟踪文件保持原样。独立 releases/<时间>-<SHA> 从 Git archive 生成，镜像带完整 SHA；current 原子切换。沿用 fafa-one Compose 项目和现有卷、数据库、Owner、加密主密钥、Google 配置、Caddy 证书。

新增 MEMBER_SELF_SERVICE=true 只取消邀请制和新注册三天赠送。普通账户仍须验证邮箱，用户名/邮箱均可登录；新 Google 注册固定 Member，不使用历史邀请升级角色。已有授权、节点、AI 和到期安全校验保留。发布事务打开 member_registration_open 并关闭 auto_grant_enabled，保留管理员关闭注册的安全开关。

部署前生成加密数据库和配置备份，并将数据库实际恢复至隔离 PostgreSQL。仅运行指定迁移，不清空生产。API/Worker 继续使用既有最小权限数据库身份。

Resend 使用 prod/fafa-one/resend 的 RESEND_API_KEY，EC2 IAM 读取，宿主 tmpfs/0400/UID1000，API 只读挂载，Worker 无邮件秘密。systemd fafa-one.service 在启动 API 前准备 tmpfs 秘密；API/Worker 使用 on-failure，避免 Docker 在秘密准备前自动启动。服务重启复用现有文件，主机重启后重新读取 AWS，不保存密钥到普通配置或镜像。

发布由服务器上的备份、构建、测试、迁移、Compose 切换与 HTTPS/真实认证验收完成。未通过的步骤必须保留实际日志，不能用模拟邮件代替真实收件。

rollback-ec2-release.sh 只恢复原应用镜像及 current 指针，保留增量表、用户和新邮件记录，不自动恢复旧数据库覆盖新增数据。旧镜像及加密备份必须保留。
