# FAFA ONE Codex 隔离执行发布记录

GPT 沿用平台 OpenAI Responses API。原生 Codex 使用独立执行 Worker 和官方 Codex CLI 0.167.0。两个入口分别由 `PLATFORM_CODEX_ENABLED` 和 `PLATFORM_CODEX_EXEC_ENABLED` 控制，默认关闭。服务账户和预算由两个入口共同使用。Owner 的个人 CLI 登录单独保留。

## 隔离预览

在现有 EC2 的已提交工作区运行 `bash infra/codex-runtime/start-preview.sh`。脚本固定当前 SHA，构建独立快照，创建带独立凭据的预览 PostgreSQL，并应用 001–011。API、网页和后台监听预览目录内的私有 Unix Socket。前台和后台通过现有 SSH 连接转发到本机 39220 和 39221。预览启用开发登录，包含三个合成用户，禁止用于正式环境。

1. 从预览后台以 Preview Owner 登录。在「AI 服务管理」录入专用 OpenAI 项目 Service Account Key，核对项目归属，检查模型访问后启用账户。
2. 配置允许的模型、默认入口、用户范围和预算，再启用平台服务。原生任务最多预留六轮模型调用的额度，低预算或过大的上下文设置会阻止入队。
3. 在「Codex 仓库授权」登记公开 GitHub 仓库和完整提交 SHA，并限定用户。运行测试需同时选择 Node 测试配方，并由提交者批准。
4. 使用预览成员验证 GPT 流式输出、实际 Usage、用户与全站限额。切换测试服务账户可验证新任务调度。已发往上游的请求不会自动重发。
5. 提交仓库编辑任务，在「我的任务」查看输出、补丁和测试结果，并操作暂停、恢复和取消。任务不会推送 GitHub。

## 运行边界

执行 Worker 独立运行，Web、API 和普通 Worker 没有 Docker 控制权限。编码容器和测试容器使用固定镜像 ID、非 root 用户、只读根文件系统、独立网络和资源上限。模型调用经私有任务 Socket 代理，代理强制使用已授权模型并过滤工具。编码容器使用专用文件工具和独立 CODEX_HOME。测试容器只运行固定的 `node --test`，工作区只读，并且没有模型代理 Socket。私有仓库和 SSH 主机执行未接入。

执行 Worker 使用 `CODEX_RUNNER_BINARY`、`CODEX_RUNNER_IMAGE`、`CODEX_RUNNER_NAMESPACE` 和可选的 `CODEX_RUNNER_SUDO`。预览 API 的 `API_PREVIEW_SOCKET` 仅限 development。暂停保留当前容器，执行服务重启会结束遗留任务。已发出的调用按收到的 Usage 结算，回执缺失时保留预留金额。

[Codex 非交互执行文档](https://learn.chatgpt.com/docs/non-interactive-mode) · [OpenAI 项目服务账户](https://developers.openai.com/api/docs/guides/api-keys)

## 生产准备

生产发布前需另行批准生产数据库变更。009 新增服务账户与用量表，放宽旧任务的账户引用并加入两类账户择一约束。010 新增模型、对话和任务用量字段。011 新增仓库授权表及任务类型、仓库关联和控制字段。新表所需最小应用权限为 SELECT、INSERT 和 UPDATE。

备份并实际验证恢复后，先在两个功能开关关闭时运行候选，再配置独立执行服务并按验收结果开放。回滚前关闭接单并收尾排队和运行的任务，再切回稳定 Release。保留新增表和记录，避免旧 Worker 接管仍处于排队状态的原生任务。
