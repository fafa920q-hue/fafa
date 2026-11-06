# 威胁模型与安全审查

## 已实施

- Google 官方 google-auth-library 校验签名、iss、aud、exp；本项目校验 nonce / state、PKCE、10 分钟 OIDC Cookie，要求 verified email。sub 唯一，不用邮箱做身份主键。服务端固定 bootstrap sub；生产禁止 dev 登录 / demo。
- 随机 256-bit 会话 / 订阅 Token；数据库只存 hash。Cookie HttpOnly / SameSite=Lax，生产 Secure。7 天绝对有效期、30 分钟闲置期；角色变更、禁用、会话撤销即时阻止 HTTP。敏感配置和管理写入需要 10 分钟内重新登录。
- 精确 CORS、Origin + 会话 CSRF；参数化 SQL、Zod 输入大小与类型校验、Helmet 安全头；API 不记录请求 URL / body，统一中文错误与 correlation ID，无堆栈泄漏。
- AES-256-GCM 信封加密，随机 DEK、独立 IV、认证标签，主密钥版本 ID；订阅 URL、节点凭据、AI Key、SSH 凭据都不明文落库。管理员无解密他人密钥接口，秘密不会写入前端 localStorage。
- SSRF：HTTPS/443、禁止 URL 认证/fragment、DNS 全地址公网检查、连接 lookup 固定已核验 IP、保留原域名 SNI、10 秒超时、1 MiB 上限、不接受压缩、不跟随重定向。禁止 metadata、保留、私有、loopback、mapped IPv6 等。
- 订阅失败保留最后成功版本，节点身份去重包含凭据与传输/TLS。Token 输出 no-store / noindex / no-referrer，并限流。
- SSH：精确 host:port 服务端白名单 + DNS 公网校验，连接固定已校验 IP，主机 key 固定，变化拒绝。默认只读固定模板 uptime；交互 shell 单独开关与额外批准，票据 30 秒一次性，经首帧发送不放 URL。WS Origin / Cookie / CSRF、每用户 2 连接、5 分钟闲置和撤销检查；不审计终端输出。
- audit_events 数据库触发器只允许追加；只记录事件名、actor、目标标识与关联 ID。

## 密钥轮换

在受保护环境配置新的 ENCRYPTION_KEY / ENCRYPTION_KEY_ID，并通过 ENCRYPTION_PREVIOUS_KEYS_JSON 加载旧 ID→base64 主密钥映射（不要提交）。先执行 `pnpm exec tsx infra/scripts/rotate-keys.ts` dry run；备份后设置 APPLY_KEY_ROTATION=true 再运行。轮换期间 API/Worker 必须加载新旧 key ring。确认全部重包并恢复演练后才能移除旧密钥。主密钥不放在数据库备份中；应有独立加密备份。

## 尚未解决 / 上线前要求

1. 目标服务器为 3.19.237.155；Google / OpenAI / 公网 SSH 和客户端导入须以真实部署后的验收记录为准。受控测试服务器和 SDK stub 只能证明实现逻辑。
2. 交互 shell 是远程用户的完整权限，不能保证逐条危险命令二次审批或沙箱；默认保持 SSH_INTERACTIVE_ENABLED=false，生产进一步采用隔离账户和受控模板。
3. Admin MFA / WebAuthn、细粒度每日 token 预算、每 Token 分布式下载限额、自动审计归档/保留清理、告警推送尚未完成。现有限流为进程内，适用于首期单 API 实例。
4. append-only 对数据库超级用户无效。开发数据库用户可迁移；上线必须建立独立最小权限运行角色，禁止 DELETE/UPDATE audit、禁止 DDL，数据库不暴露公网。
5. 无自动硬删除与自动备份调度；脚本须由运维在新数据库上恢复演练。没有专业渗透测试；规则扫描与依赖审计不等于完整安全认证。
6. 不从用户网页搜集任何 ChatGPT 登录材料，不提供 iOS GPS 改写或伪造定位承诺。
7. 新安装使用主域名 host-only Cookie，管理端带凭据访问主域名 API，CORS/CSRF 精确允许两个正式 Origin。升级保留已有 Cookie 作用域。设置 COOKIE_DOMAIN 时所有子域须受控，避免子域 Cookie 注入。API 只信任直接反向代理；未开启通用 trustProxy，部署多层代理前须配置精确可信网段。
