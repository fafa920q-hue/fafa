# 双域名调整与验收记录

目标：3.19.237.155；PR #2 继续提交，不创建 API DNS，不购买服务器。

## 实现

- 生产 Caddy 仅使用 PANEL_DOMAIN / ADMIN_DOMAIN；主域名后端路径互斥代理，保留 /api 前缀，管理域名后端路径不返回 SPA。
- Admin 独立构建固定请求主域名，Web 使用相对路径；统一请求、SSE、WSS 地址生成，精确 CORS / CSRF 与生产 HTTPS 校验。
- Google 回调固定 https://fafa888.uk/auth/google/callback；新安装 host-only Cookie，保留已有 COOKIE_DOMAIN。
- 新订阅下载走 /api/subscription/download/:token；旧 /subscription/:token、令牌、权限及撤销行为保留。无数据库迁移或数据重置。
- 生产 API 没有 ports / host network，4000 仅容器内监听；原卷及运行安全设置保留。

## 真实执行状态

本次本地命令启动被执行器阻断：`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`。错误发生于 shell 运行前，不能认定为目标 AWS 服务器故障。GitHub 连接可读取和提交 PR；CI 运行结果以本提交关联 Actions 为准。

生产部署及真实 Google 账户、真实订阅客户端与公网 SSH 尚未执行 / 验证。需要可用的既有 SSH/SSM 或部署 CI 入口，不能把临时 CA、Google fixture、SSH fixture 或历史 CI 结果标记为生产成功。

自动测试与发布步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。不在此文档保存密码、私钥、Cookie 或完整订阅链接。
