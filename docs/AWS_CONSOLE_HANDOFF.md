# us-east-2 首次生产发布：最少控制台步骤

目标仅为 3.19.237.155、/opt/fafa-one、fafa888.uk 与 a.fafa888.uk。服务器当前源码由用户报告为 43bb8a1，生产容器未启动，.env.runtime 和 .deployed-sha 不存在属于首次发布的正常前提。不要手工生成或复制这两个文件，不覆盖 .env.production，不重新安装 Docker、磁盘、Swap 或 Deploy Key。

## 优先复用现有 Session Manager

1. AWS 控制台切换到 **Ohio / us-east-2**。EC2 → Instances，用公网 IP 3.19.237.155 找到唯一实例，记录非秘密 Instance ID。只读核对 Security 页面：TCP 80/443 可公开访问，TCP 4000/5432 不公开。缺少规则或权限时停止，取得单独授权后再处理；本流程不编辑安全组。
2. 选实例 → Connect → Session Manager → Connect。若不可用，在 Systems Manager 的受管节点列表检查同一实例和 Online 状态；没有节点、连接权限或现有实例角色时交 AWS 管理员核验，未经批准不安装 Agent、不授予 IAM、不修改网络。无需向聊天发送任何密钥。[AWS 官方操作](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)

连接后先执行以下检查。sudo 检查失败时停止并说明当前终端权限，不反复尝试，不把失败当作主机故障：

```bash
cd /opt/fafa-one
whoami
id
pwd
sudo -n true
```

成功后继续只读检查：

```bash
git rev-parse HEAD
git status --short --untracked-files=no
stat -c '%a %U:%G' .env.production
bash -n infra/scripts/deploy-production.sh
sudo env IMAGE_TAG="$(git rev-parse HEAD)" docker compose --env-file .env.production -f infra/docker/compose.production.yaml config --quiet
sudo docker ps --all --filter label=com.docker.compose.project=fafa-one --format json
```

必须确认 HEAD 是完整的获批准 SHA、跟踪文件无修改、环境文件为普通文件且权限600。不要输出 docker compose config 的正文、docker inspect Env、.env 内容或凭据。值级校验由现有发布脚本在构建后、数据库改动前运行：生产标志、Google 回调、Caddy 域名、Cookie 域及管理员数据库密码一致性；检查失败不自动重置密钥。首次没有匹配镜像时，不能声称已完成容器内值级审计。

## 人工批准后调用原发布入口

下面 SHA 是用户当前报告的版本；如需使用后续工具修复，先审核其完整 SHA 与 CI，再同步干净工作区，不执行 reset --hard 或覆盖本地配置。

```bash
sudo bash infra/scripts/deploy-production.sh 43bb8a1961b0a5b4f3bf0859219664d7a0f17541 deploy
```

必须沿用该脚本的部署锁、Git archive 构建、迁移前加密备份、认证解密/目录验证和运行时角色机制。顺序是：构建 → 配置审计 → PG 初始化/健康 → 备份及验证 → 创建运行时身份 → 迁移001–003 → 授予最小权限 → API/Worker/Web/Admin → Caddy → 状态证据。仅创建新的 app 角色凭据，不重设已存在的 PostgreSQL、加密或 Google 密钥。

失败保留原卷、配置、密钥、加密备份和旧镜像。不得通过清空卷、删除 .env.runtime 或重设密码重试。不要独立执行裸 compose up 替代发布脚本。

成功后只分享脱敏结果标记和 deployments 下的服务/迁移/Owner计数文件，不上传配置、数据库 dump 或完整生产日志。检查：

```bash
sudo bash infra/scripts/production-compose.sh ps --all
curl --fail --silent --show-error --max-time 15 https://fafa888.uk/api/ready
curl --fail --silent --show-error --max-time 15 https://fafa888.uk/auth/config
curl --fail --silent --show-error --max-time 15 --output /dev/null https://a.fafa888.uk/
```

## 保留现有 GitHub Actions / OIDC 方案

已有 OIDC/SSM 时，不必重新创建。production Environment 保持人工审批且禁止管理员绕过；环境变量 AWS_REGION=us-east-2、AWS_INSTANCE_ID、AWS_ROLE_ARN 均为非秘密，仓库变量 FAFA_DEPLOY_ENABLED=true 由获授权维护者设置。既有工作流等待同 SHA CI，再等待批准，只读核验实例IP、Online与安全组后发送固定 SSM 文档。

尚无 OIDC 时，优先上述现有 Session Manager 终端路径，避免为了首次上线额外修改 IAM。需要新增 OIDC/实例角色时，管理员先批准并审查 infra/deploy 的精确实例/文档策略与精确 sub 模板；没有授权保持关闭。工作流支持开发分支 push，不为上线合并 main；若界面不能从该分支手动启动，使用上述既有终端路径，不绕过审批。

## Owner 与真实验收

Owner 按 [OWNER_SETUP.md](OWNER_SETUP.md) 在服务器**未录制的受信交互终端**生成，随后由账户持有人在正式 HTTPS 页面输入并 Google 登录。若 Session Manager 会话有 S3/CloudWatch/终端记录，不在其中输出 Owner 凭据，也不擅自关闭记录策略。CI、SSM Run Command、聊天和截图均不得接收该凭据。

Google/Owner、第三方再分发许可、轮换后节点、每用户订阅、OpenAI真实调用、公网SSH与iPhone真机都需真实条件才能签收。CI 首次启动/恢复证据只来自一次性测试卷，无AWS访问；它不启动公网Caddy，不申请正式域名证书，不等同生产部署。
