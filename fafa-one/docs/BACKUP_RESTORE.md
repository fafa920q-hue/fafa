> 这是备份操作参考，不代表生产备份已执行；真实状态以 RELEASE_GATES.md 和 ROLLBACK.md 为准。

# 备份恢复手册

仅由授权运维在目标环境执行。备份含密码哈希、会话摘要、节点配置等敏感数据，必须受控权限、加密异地存储、定义保留期；不得加入项目 ZIP。

## PostgreSQL（Compose 默认）

`pg_dump` 使用一致性快照。备份路径请放入专用备份磁盘。

```bash
umask 077
mkdir -p backups
docker compose exec -T db pg_dump -U fafa -d fafa -Fc > backups/fafa-before-change.dump
docker compose exec -T db pg_restore --list < backups/fafa-before-change.dump > /dev/null
sha256sum backups/fafa-before-change.dump > backups/fafa-before-change.dump.sha256
```

命令失败要删除不完整备份。`--list` 验证格式，不等于完整恢复演练。完整演练应恢复到**新的独立数据库**并运行权限、用户数量、外键、任务与审计对账：

```bash
docker compose exec -T db createdb -U fafa fafa_restore_check
docker compose exec -T db pg_restore -U fafa -d fafa_restore_check --exit-on-error < backups/fafa-before-change.dump
```

不要对现有生产库使用 `--clean` 或覆盖导入。正式恢复先暂停本项目写入和独立 worker，创建新库恢复、验收后切换 DATABASE_URL；保留旧库供回退。更换 APP_SECRET 不会自动清理 opaque sessions：恢复后要在新库中执行 `DELETE FROM sessions; DELETE FROM auth_tokens; DELETE FROM oauth_flows;` 撤销复活的历史凭据，并在审计记录恢复事件。执行 SQL 只在已确认的新恢复库。

本次本地 PostgreSQL 测试已验证 schema/API；真实生产备份保留与恢复切换未执行。推荐通过系统定时器运行受审查备份脚本并监测退出码，不能把运维页状态当成备份已完成。

## SQLite（开发）

```bash
.venv/bin/python scripts/backup.py /path/source.db /secure/new-backup.db
.venv/bin/python scripts/restore.py /secure/new-backup.db /path/new-restored.db
```

备份调用 SQLite backup API，验证 integrity_check；目标文件必须不存在，权限 0600。恢复只写新路径，不覆盖活动数据库。先暂停本项目写入，切换配置到新路径，核对 foreign_key_check 和会话撤销，再启动。不要只复制活动中的 .db 而丢掉 WAL。

## 非数据库内容

分别保存受控的 secret 文件、.env（加密）、镜像 digest、Compose/反向代理候选配置、Agent 白名单/配置和 worker 独立 workspace 的版本。恢复数据库不会恢复远端节点和仓库状态；必须核对外部操作是否实际执行，不要盲目重放任务。
