# 回滚与恢复操作手册

本项目没有生产部署记录。以下流程供以后在用户自己的新服务器上执行；本次只进行了独立测试数据库的加密备份与恢复，未改变生产 DNS、域名或服务器。

## 发布前保留项

- 保存当前镜像完整 tag / digest、Git SHA、Caddyfile 和非秘密配置版本。
- 数据库执行 `infra/scripts/backup.sh`，确认成功退出且生成 age 加密文件；主密钥及旧 key ring 单独保存在受保护密钥管理中。
- 在新空数据库恢复该备份，校验表计数、加密凭据可解密及 API readiness，再开始变更。
- 迁移由一次性 migrate 服务执行。不要通过修改已应用 SQL 文件或删除 migrations 记录进行回滚。

## 只回退应用镜像

仅在旧版本兼容当前数据库 schema 时使用。保留生产 `.env.production`，在运维终端指定已验证的旧 IMAGE_TAG：

```bash
export IMAGE_TAG=已验证的旧镜像标签
docker compose -f infra/docker/compose.production.yaml pull api worker web admin
docker compose -f infra/docker/compose.production.yaml up -d --no-deps api worker web admin
```

镜像来自自己的可信镜像仓库；示例默认使用本机镜像名，按实际 registry 配置。不要执行 migrate 服务的降级，不删除数据库卷。检查 api/worker health、用户登录、订阅导出、资源隔离和错误日志；失败时停止写入，转入数据库恢复流程。

## 需要恢复数据库时

1. 暂停应用写入并停止 API / Worker：`docker compose -f infra/docker/compose.production.yaml stop api worker`。保留原数据库、数据卷与故障现场。
2. 创建全新的空数据库，不在原数据库上覆盖。安全注入 RESTORE_DATABASE_URL、AGE_IDENTITY_FILE，并设置 `CONFIRM_RESTORE=RESTORE_TO_NEW_DATABASE`。
3. 执行 `bash infra/scripts/restore.sh 加密备份路径`。脚本先拒绝非空库，再以单个 PostgreSQL 事务恢复；不会执行 `--clean`。失败时不切换流量。
4. 使用匹配的加密主密钥和兼容镜像连接恢复库，校验 readiness、数据计数、凭据解密、订阅 Token 和权限。记录备份时间与可能丢失的写入范围，不承诺零数据丢失。
5. 将受保护 DATABASE_URL 改为恢复库，启动 API / Worker，核验后再恢复访问。原数据库继续保留，直到人工确认保留期与删除授权。

## 已执行的演练

`pnpm verify:backup` 使用随机命名的两个一次性 `_test` 数据库，实际调用 pg_dump → age → 解密 → pg_restore。报告在 [backup-restore.json](evidence/backup-restore.json)：27 张表计数一致、凭据可解密、审计触发器保留，且缺少确认和非空目标均被拒绝。测试结束只删除本次创建的测试库和临时 age 私钥。

该演练不等于生产容量下的 RTO/RPO 测试；首次上线前仍应演练实际备份调度、异地副本与恢复耗时。
