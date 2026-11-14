# 生产 Resend 密钥接入

新发布只接受 AWS Secrets Manager 的 AWSCURRENT SecretString，或 SSM SecureString。
已泄露的密钥禁止使用。不得把新密钥写入 `.env.production`、Git、PR、报告、CLI 参数或 Docker environment。

复用 `us-east-2` 的 `prod/fafa-one/resend` 与 EC2 角色 `FAFA-ONE-EC2-Secrets-Role`。SecretString 必须使用 `RESEND_API_KEY` JSON 字段，读取 AWSCURRENT。引用不是密钥。所需权限仅为指定资源的 `secretsmanager:GetSecretValue` 或 `ssm:GetParameter`，使用客户 KMS 时还需对应的解密权限。脚本不创建角色、不更改 IAM、不轮换或覆盖秘密。

审核后由 `infra/deploy/stage_resend_secret.py` 在 Linux root 下读取该引用，检查输出文件所在文件系统确为 tmpfs，创建 `/run/fafa-one/secrets/resend_api_key`，UID 1000、模式0400。已有文件被保留并拒绝覆盖。任何 AWS 错误只显示异常类型，不输出请求/响应或密钥。文件仅由 API 的只读 Compose secret 挂载读取；Worker 不挂载、不获得环境密钥。API 配置了文件后，如果缺失、权限过宽、是符号链接或内容非法，失败关闭，不使用旧环境值。

`deploy-production.sh` 的部署路径要求该 tmpfs 文件，并强制加载 `compose.mail-secret.yaml`。现有只读 `check` 不需要秘密，也不更改生产。日常 `production-compose.sh` 在文件可用时使用相同 overlay。宿主机重启会清空 tmpfs；须先由持有最小 AWS 身份的受控启动步骤重新取回秘密，再恢复 API。没有密钥时不能报告邮件健康。

合成 CI 可继续以原隔离环境夹具验证邮件协议；真实发布必须运行文件秘密专项测试，核对 Docker 元数据没有真实 Key、Worker 无秘密挂载，并由持有人完成真实收件、验证码注册与恢复验收。Resend 接受请求、域名 DNS 正确或 CI 通过都不代表收件成功。

2026-11-08 只读复核：角色绑定、临时 STS 身份、账号和区域均匹配，Secret 读取及 `RESEND_API_KEY` 字段格式校验成功，真实值只留在服务器进程内存。Resend 域名 verified、Sending enabled、DKIM/SPF verified。获持有人单封授权后，真实验收信被服务商接受，后续状态为 delivered；收件箱归类仍须收件端证据。未运行 staging、未改变生产配置/数据库、未部署。本文件是候选接入说明，不代表生产 API 已接入。
