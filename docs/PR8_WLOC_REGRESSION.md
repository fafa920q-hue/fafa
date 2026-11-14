# PR #8 WLOC iPhone 回归与整合交接

基线：cd1a36269e67f5d0bdc26d959474d9dc467ca24a（feat/member-auth-integration-b4dd0cea）。
原始失败：Member authentication checks #29 / Actions 42390559508；主工作流 #102 已取消。

## 已读取的证据

原始 member-auth-test-evidence artifact 13582362260 包含 Playwright JSON、iPhone trace、error-context 与 PNG。
通过仅 contents:read/actions:read 的独立诊断分支 codex/pr8-wloc-evidence 在临时 GitHub runner 读取；不访问 AWS。
诊断仅输出动作类型、时长、宽度、错误状态、固定按钮名称和一张合成测试画面；
不会输出 trace 的 Cookie、CSRF、Authorization、网络正文或个人账户凭据。
本地 shell 因此前 bwrap 限制未执行，没有再次尝试绕过。

原日志：108 passed、6项既有条件跳过、1 failed；iPhone 在原单例60秒截止后报 context closed。
该轮矩阵前磁盘尚余约27GiB，未见 ENOSPC；不能把历史磁盘问题当作本次根因。
trace 表明同一用例连续执行375、390、430、768、1440px，逐次应用坐标与主题切换。
多次点击分别耗时2–8秒，至1440px主题切换与整页截图已耗尽用例总预算。
context/browser closed 是计时器终止后的后续错误，不构成浏览器自行崩溃证据。
CI竞争可能放大时长，但原日志无CPU/OOM证据，不把它写成已证实根因。

独立诊断保留原代码与原60秒限制，再次实际复现失败。
[原始证据与同源复现运行](https://github.com/fafa920q-hue/fafa/actions/runs/42400338487)
中的旧用例确实复现超时；同一运行中修复后的iPhone/WebKit矩阵连续两轮20例全部通过，
各例仍为60秒，iPhone最慢42.3秒。诊断工作流整体failure来自故意保留的原始失败，不是新用例失败。
原始1440px iPhone整页PNG达到4320×7179像素；新截图限制为CSS视口像素，设备模拟DPR保持不变。
这些隔离诊断结果不能冒充最新候选SHA的全量CI；发布门禁仍看该SHA两路完整工作流。

## 修复范围与覆盖

WLOC修复仅修改测试结构、截图策略和定向CI；不修改应用UI、Google/Owner、节点或持久数据。
五种宽度改为五个独立60秒用例；每种仍验证浅色与深色、主题双向切换、无横向溢出、
坐标输入/应用与选中值、保存按钮启用。增加滚动后处于视口内与中心命中检查，真实遮挡会失败。
不提高全局或单例超时，不删除断言、不新增skip、不添加固定等待。

截图使用有限视口与CSS像素，避免iPhone DPR=3的整页巨大位图；
各浅深主题PNG按testInfo.outputPath隔离并附加到报告，不写入生产或公开文件。
协议操作用例仍执行全部真实收藏API与设备夹具断言，仅将其证据截图改为有限视口/CSS像素。

## 验收范围

独立诊断先执行定向iPhone/WebKit；账户专项也先执行最重的1440px iPhone定向回归，随后两路完整CI均须在最终SHA通过。
必须保留20项账户/邮箱/增量升级安全测试、现有API与Owner测试、全部浏览器、
Docker HTTPS、数据库持久化、备份恢复和原有UI/节点回归。
自动浏览器与合成模块结果不是实际iPhone定位、真实邮件收件或正式Google/Owner登录验收。

## 注册部署配置审阅

接管时生产Compose未传递MAIL_*，只有未接入发布脚本的未来overlay；即使持有人配置环境文件，API也无法使用。
本次在API环境中合并完整既有运行时环境并转发三个可选邮件变量，不给Worker增加邮件密钥；
只更新环境模板，不覆盖生产文件、不生成或轮换实际密钥、不调用邮件提供商。
隔离Startup使用随机合成邮件Key检查真实Compose合并、运行时配置可见、注册默认关闭、迁移005已应用，
以及五张Member表仅有SELECT/INSERT/UPDATE而无DELETE/TRUNCATE。原有备份恢复、数据库持久化与端口检查保留。

## 发布边界

生产发布必须复核当前实际生产SHA、备份、迁移005运行时角色权限及环境配置，
保留现有Owner、密钥、.env.production和Docker卷。公开注册保持关闭，直至持有人完成真实邮件验收。
只通过既有受保护SSM/OIDC部署；没有该执行权限、required review或指定SHA批准时交接，不宣称部署。
PR #5在本次接管时HEAD为aaa249242e7b52e9542898e74c4c2cca18bff160，主CI #99成功、PR仍open且未merged；
生产是否含该功能需实际执行通道证据，不凭CI或PR状态推断已上线。
轮换后且有合法使用/再分发授权的真实节点须通过可信HTTPS管理页面导入；本轮未导入，
Shadowrocket/v2rayN真机网络与iOS WLOC实效保留为待实际验收。
自带Codex账户与自有服务器执行继续保留后续计划，本修复不开发该功能。
