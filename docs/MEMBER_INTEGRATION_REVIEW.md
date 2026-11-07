# 普通账户分支与Muse版本整合准备

账户分支基线：7ee1c7b97d6abfd95bf261b99b8242c5aeae203c。已确认账户提交94fdd8d81861129f0540e348fcb759b3c2ea3692的全量CI #72四个Job通过；浏览器84通过、6项既有条件跳过。后续提交须看其自己的CI，不能沿用该结果冒充新SHA通过。

本轮观察到Muse分支b89e9b4752fa5bfe59303b346ce15b32ebcd7a1a，新增按web/admin返回登录来源的修复；其CI当时仍运行，不能据此称其已稳定或获生产批准。本文件不合并该版本，也不修改PR #2。

## 自动只读预览

账户专用CI在独立checkout中执行：

~~~bash
pnpm exec tsx infra/scripts/member-integration-preview.ts --artifact
~~~

脚本读取本次checkout已取得的origin/feat/fafa-one-control-panel，用git merge-tree构造Git对象预览，输出双方完整SHA、共同基线、是否干净合并及冲突文件名。不会checkout目标、合并工作区、更新任何ref、推送、部署或访问数据库。报告为docs/evidence/member-integration-preview.json，列在账户CI artifact中。

有冲突时报告cleanMerge=false，账户安全测试仍必须完整执行；预览成功不代表冲突已解决。没有已取得的目标ref或Git命令失败时工具失败关闭，不隐式fetch其他凭据。

## 已识别的语义冲突

双方都修改apps/api/src/server.ts的startGoogle：

- Muse第三个参数是app（web/admin），并把来源放入加密OIDC flow，回调只在批准的两个Origin之间选择。
- 账户分支第三个参数是memberLink（绑定记录ID），用于密码证明、原会话、同一验证邮箱和单次绑定。

不能机械选择任一侧，或把绑定ID当作app传入。整合时改用有名称的选项对象，例如：

~~~ts
type GoogleStartOptions = {
  app?: 'web' | 'admin';
  ownerCredential?: string;
  memberLink?: string;
};
~~~

统一签名startGoogle(reply, options)，在服务端生成sealed flow时同时保留app、memberLink、ownerCredential、state、nonce、verifier和时间。普通Google登录按经过枚举验证的app返回前台/后台；Member绑定成功固定回前台/member/account，并撤销原会话、创建新会话。Owner初始化只保留原机制，现有生产Owner不重新初始化。

必须保留账户分支createSession的用户状态锁及expectedPasswordHash复核；重置密码之后的旧验证结果不能创建新会话。不得为解决冲突恢复到旧的无复核实现。

## 文件及集成方式

|范围|处理要求|
|---|---|
|core.tsx、style.css、admin-nodes.spec.ts|保留Muse稳定版本，本分支不直接编辑|
|Muse endpoints/loginApp及登录返回测试|完整保留，与账户新入口共存|
|server.ts|人工审阅上述有名选项整合，补充双来源与Member绑定的联合回归|
|新member API、页面、密码/邮件模块|保留本分支实现和安全测试|
|web/admin main.tsx|保留双方已有路由，增添独立/member入口和后台注册策略，不改变视觉系统|
|005迁移和运行时授权|确认Muse没有占用005；冲突则由集成人员重编号、同步迁移清单和升级测试，不改已应用迁移内容|
|生产Compose邮件变量|先审查独立compose.member-auth.yaml，再纳入原受保护发布机制；不直接裸compose up|
|现有登录卡片快捷入口|待Muse稳定后由集成人员加入普通账户链接，本分支不改共享core.tsx|
|原CI与生产部署工作流|保持人工审批及原安全检查，不为账户功能绕过|

check-member-isolation.ts以原确认基线检查账户自身改动，故正式整合Muse后必须由集成人员审阅并更新隔离检查的比较基线，避免把继承的Muse修改误判为账户改写。更新前应保留双方原SHA和冲突解决记录。

## 整合后必须重新验证

1. 格式、Lint、类型、单元、账户数据库/升级、现有API和Owner、Docker HTTPS及启动/备份恢复检查。
2. Google web/admin来源枚举、sealed state、nonce/PKCE/iss/aud/exp、错误来源、绑定ID与app不混淆、Owner原身份和普通账户后台拒绝。
3. 普通注册/激活/登录/找回/重置/会话撤销及过期密码证明拒绝；真实邮件按MEMBER_MAIL_ACCEPTANCE.md另行确认。
4. 保留Muse节点页面测试，完整Chrome/Firefox/WebKit/iPhone/Android矩阵与既有UI。
5. 人工审查整合提交，明确新的40位SHA生产批准；此后才可调用原发布入口。

本轮预览和CI不构成生产发布授权，没有操作AWS、生产数据库、密钥或Owner。不能将单独账户分支的全绿结果当作尚未产生的整合提交全绿。

PR存在合并冲突时GitHub不会触发pull_request工作流（[官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)）。因此账户分支的push CI独立执行完整浏览器矩阵、Docker HTTPS、Production Startup、部署工具与Windows检查，不等待Muse，也不改用具有更高风险的pull_request_target。测试明确检出本分支SHA；这仍不是整合提交的验证或生产授权。
