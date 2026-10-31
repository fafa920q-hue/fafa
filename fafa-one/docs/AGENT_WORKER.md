> 归档 v1 本地兼容契约，仅作参考；本次没有接通真实 Codex、Claude Code 或生产 Agent。

# 独立 Agent / Worker 协议与部署边界

本协议由 FAFA 自己定义，并非声称 Xray、V2Ray 或 sing-box 原生提供这些 HTTP API。

## Node Agent

`agent/main.py` 是可独立运行的 FastAPI 服务；镜像构建上下文须为项目根目录：`docker build -f agent/Dockerfile -t fafa-node-agent:1.0.0 .`。不要在当前生产节点直接启动，先在独立测试节点验证。以 UID 10002 运行；配置目录单独可写、白名单/引擎二进制只读挂载；禁止 host Docker socket、root 和任意 shell。Agent 不内置任何引擎，也不自动升级引擎。

环境：`AGENT_CONFIG_ROOT=/data/configs`、`AGENT_ALLOWLIST=/etc/fafa/nodes.json`、`AGENT_TOKEN_FILE=/run/secrets/node_agent_token`。外层需 TLS 和网络访问控制，只允许管理平台连入。生产密钥通过受控文件挂载，两端引用相同 secret。不要公开 8100。

白名单示例（自己创建，归档不含真实节点）：

```json
{"sg-test":{"engine":"sing-box","config_file":"sg-test.json","pid_file":"/run/sing-box/sing-box.pid"}}
```

只允许 xray / v2ray / sing-box。`config_file` 必须落在配置根目录内；`pid_file` 只来自运维白名单且需要正确进程命名空间，不能从客户端传入。健康只在 `/proc/PID/exe` 名称匹配引擎时报告进程验证成功；它不等价于数据面连通性验证。错误不能证明离线，显示 degraded / unknown。

认证令牌至少 32 字符。认证：`Authorization: Bearer <mounted token>`。`POST /v1/nodes/{allowlisted_ref}/{health|apply|rollback}`，JSON `{"config":null}` 或 `{"config":{...}}`。响应 `source=FAFA_AGENT`、`status=ok|degraded`、metrics（明确 scope）、message。API 展示的 latency 是管理端到 Agent 的 HTTPS 请求 RTT，不是代理线路延迟。

配置采用官方 CLI：Xray `xray run -test -config FILE`；V2Ray **v5** `v2ray test -c FILE`；sing-box `sing-box check -c FILE`。安装版本必须与节点引擎配置格式匹配。仅固定 argv、无 shell。新配置校验通过后 0600 原子替换；`config_written=true` 表示暂存，`runtime_activation=not_performed`。平台存新的配置版本，可把历史版本重新提交作配置文件回滚。**不执行重启/重载**，运行态回滚依赖后续受限服务控制集成。配置可能包含节点敏感信息，DB、备份和磁盘必须受保护；配置内容不返回普通用户。

metrics 是 Agent 自身 CPU 秒、RSS、配置目录磁盘空间和 Agent 网络命名空间累计字节；值缺失为 null。完整整机百分比和线路探测需另接真实监控，不能用随机数填充。

官方参考：
- https://xtls.github.io/en/document/command.html
- https://www.v2fly.org/en_US/guide/command.html
- https://sing-box.sagernet.org/configuration/

## Codex worker

平台仅提供 `Executor` 接口、`RemoteExecutor` 和 `worker/sandbox.py` 启动参考，不附带可直接生产运行的 worker HTTP 服务或 Codex 授权。未配置 CODEX_WORKER_URL 时审批结果为 not_configured，attempts=0，无虚构日志/diff/测试结果。

operator 实现的 worker 应支持（本平台自有契约）：
- `POST /v1/jobs`：幂等 idempotency_key，repository、prompt、timeout_seconds、approval、limits。响应 `{"id":"opaque-safe-job-id"}`；同 key 不得重复启动。
- `GET /v1/jobs/{id}`：status=running/succeeded/failed/cancelled，logs、changes（相对路径）、diff、tests（真实执行结果）和 error。
- `POST /v1/jobs/{id}/cancel`：只有容器确实停止才返回 cancelled；否则未确认。
- `POST /v1/jobs/{id}/rollback`：在隔离工作区执行经验证的 Git 回滚，明确返回 rolled_back。禁止通过 Web 拼 shell 或直接覆盖服务器仓库。

TLS、独立 token、服务身份校验、仓库域名和 DNS/IP 白名单（禁止私网/metadata URL 和重定向）、仓库大小限制、镜像 digest 白名单、工作目录唯一、Git 凭据隔离、日志脱敏由可信 worker 强制实施。API 请求中的 limits 只是契约，不能当作第三方 worker 已经执行限制的证明。

参考启动器在独立 rootless Docker daemon 上执行固定入口 `/usr/local/bin/fafa-job`；prompt 走标准输入 JSON，不拼命令。限制 1 CPU、512MiB、128 PID、只读 rootfs、无 capability、no-new-privileges、非 root UID、临时目录、仅独占 workspace 写入、network=none、超时或输出超过 1MB 强制删除容器。Web API 不导入启动器、不拥有 docker socket。仓库预置及 executor 镜像由 operator 审查实现。

真实 Codex 云端调用需要合法授权和受限出口；默认断网的参考不能直接宣称支持联网调用。外部 worker 应有独立 watchdog，在 API 停止后仍强制超时。取消未确认的超时任务不能重试，必须先在 worker 确认无遗留任务。测试中的 FixtureExecutor 和 subprocess mock 都标记 TEST，不是容器执行的证明。
