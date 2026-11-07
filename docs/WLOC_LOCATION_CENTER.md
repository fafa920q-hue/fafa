# WLOC 位置中心：独立客户端与交付说明

## 范围和基线

从 Muse 已确认的 b89e9b4752fa5bfe59303b346ce15b32ebcd7a1a 创建 feat/wloc-location-center。
本分支不含尚未合并的注册登录 PR #4，不改变 Google OAuth、唯一 Owner、会话、节点分配或数据库迁移。
保留浅蓝紫玻璃设计，新增样式仅在 apps/web/src/locations/wloc.css。
Muse 独立负责生产发布：本 PR、CI 或模拟设备测试都不构成生产发布授权。

## 上游审计与许可证

研究 Yu9191/wloc main 的完整提交 2644722da7f61256786686983b4fb8500904de8b：
modules/wloc.module、dist/wloc.js、dist/wloc-settings.js、
worker/src/page.js、worker/src/index.js 及其地图链接解析、坐标转换实现。
上游 LICENSE 是 AGPL-3.0；README 另有未经授权禁止商业使用的声明。
两者范围需由权利人与使用方确认，不能将公开仓库等同于商业授权。
本功能独立实现公开请求协议，不复制、修改、打包或托管上游脚本、Worker 页面或模块。
用户安装原版模块前须阅读许可证并取得适用于自身用途的授权。
原版模块地址指向 main 且内部脚本引用 main；审计 SHA 不意味着设备脚本已固定版本。

地图客户端 Leaflet 1.9.4 (BSD-2-Clause)、坐标库 gcoord 1.0.7 (MIT) 本地构建；
完整声明位于 docs/WLOC_THIRD_PARTY_NOTICES.txt，静态镜像继续分发该文件。
底图 OpenStreetMap 标注不能移除；不预取、不离线批量下载、不禁用浏览器瓦片缓存。
瓦片单独设置 referrerPolicy=origin，仅发送源站，不发送用户路径、查询或凭据。
Photon 软件 Apache-2.0，数据需保留 OSM 署名。公共搜索服务仅合理有限使用，无 SLA；
不使用上游作者的公共 Worker，也不直接依赖 Nominatim 公共服务。

参考：

- https://github.com/Yu9191/wloc/tree/2644722da7f61256786686983b4fb8500904de8b
- https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE
- https://github.com/hujiulong/gcoord
- https://github.com/komoot/photon
- https://operations.osmfoundation.org/policies/tiles/

## 地图和坐标

全球地图拖动选中心、点选、拖动标记；手动输入优先显示 WGS84，可从 GCJ-02/BD-09 转换。
浏览器不读取本机定位。极区超出墨卡托瓦片范围时明确提示，保存值不会被裁切为底图边界。
Apple ll/coordinate/sll 使用纬度、经度；Amap position/lnglat 使用经度、纬度；
Amap p 为 ID,纬度,经度；Baidu location 按 coord_type 或 BD-09，支持 BD09MC 路径；
Google 采用精确 pin !3d/!4d 或数值 query/q，不把视窗 @ 中心冒充 POI。
中国及邻近区域 Apple/Google 的坐标系不明确，必须手选，不能猜测转换。
不支持的短链/无坐标页面明确失败，要求复制含坐标长链或手动输入。
百度显式 coord_type 支持 WGS84/GCJ02/BD09LL/BD09MC 及对应经纬度别名，未知类型拒绝解析。
海外百度链接未声明坐标系时须手动确认，避免把官方所述海外 WGS84 自动当成 BD-09。
参考：[百度坐标系说明](https://lbsyun.baidu.com/skins/MySkin/resources/iframs/coordinate.html)。

收藏通过现有 /api/location_presets 真实持久化，按 owner_id 隔离、保留 CSRF/Origin。
新收藏保存 coordinateSystem=WGS84；旧记录原样保留，选择后须明确坐标系并应用才能写入设备。
无需新表、重置、批量改写旧记录或 Owner 初始化。
IP 出口策略保留，更新国家筛选时保留原有协议与分组。

## 搜索和安全展开

已登录 GET /api/location-tools/search?q=...，最多 160 字符，非实时自动完成；
固定 Photon-compatible 服务响应仅输出最多 6 个有界 Point 与文本标签。
默认 https://photon.komoot.io/api/，可由部署者配置 WLOC_SEARCH_URL 为获批 HTTPS/443 Photon-compatible endpoint，
或 WLOC_SEARCH_ENABLED=false 禁用。URL 不能含认证、查询或片段；部署者负责服务条款和访问容量。
单 API 进程限制每 1100ms 一次外呼、并发 1、128 条哈希键缓存 10 分钟；
多副本部署前须增加共享限流或独立供应商。本项目当前单 API 实例。
客户端收到失败状态，不把失败当作空搜索成功。

已登录 GET /api/location-tools/resolve 只接受代码列出的地图域名；
每次跳转重新验证 HTTPS/443、无凭据、固定域名白名单、所有 DNS 结果为公网并固定实际连接 IP。
最多 4 次跳转，禁止重定向至 EC2 元数据、私网、任意代理和 Apple 设备配置端点。
总请求体上限 256 KiB、单次网络请求 8 秒，不转发用户 Cookie/Authorization/CSRF。
本服务无请求日志；不要在反向代理/APM/分析平台启用含地址查询或设备请求 URL 的日志。
地图搜索地址会发给配置的地图提供方，瓦片会暴露视野范围；页面提前告知。
不会把收藏内容、身份令牌或 Google 凭据发送给地图提供方。

## 手机设备协议与限制

所有设备请求直接来自当前浏览器，不经 AWS API：
HTTPS gs-loc.apple.com 或 gs-loc-cn.apple.com 的 /wloc-settings/save：

- 保存：GET ?lon=...&lat=...&acc=25&randomRadius=0
- 查询：GET ?action=query
- 清除：GET ?action=clear

使用 mode=cors、credentials=omit、referrerPolicy=no-referrer、无自定义认证头、8 秒超时、禁止跳转。
原版模块 CORS 使用 *，此请求不携带 Cookie，不能改成带凭据的通配符方案。
只接受 JSON success 响应；保存须随后 query 与坐标/精度/半径一致才确认；
清除须随后 query 返回 success=false,error=无已保存的坐标，不能把任意错误当作空状态。
超时后状态未知，先查再写，不自动重试或切换端点写入。
保存结果只能证明当前模块的配置回读，不能证明 iOS locationd 或任意 App 定位生效。
原版 truthy 坐标判断对 0 经纬度有缺陷，写入零坐标明确阻止，地图/收藏不受影响。

原版主脚本在设备配置清空后可能使用模块静态参数：
只有静态参数保持原版默认值才恢复透传；自定义过参数须恢复默认或停用模块。
清除配置不是“真实定位已恢复”证据，需实际地图重新请求定位、等待缓存并核验。

## Shadowrocket 与 iOS 验收

页面内含完整中文安装和恢复向导，不自动安装证书、改变信任、配置 AWS 证书或运行定位脚本。
使用原版模块指定五个 MITM hostname，不扩大通配符。
设备本人生成证书、手动安装并信任，见 https://support.apple.com/102390 。
上游 2026-11-04 报告部分 iOS 18/26 拦截失败，原因未确认；
上游报告 iOS 27 beta 6+ locationd 拒绝非 Apple CA。此为上游报告，不是本站真机结论。
不建议关闭系统安全设置、降低服务器 TLS 验证或将证书绕过当作成功。

必须由账户持有人在真实 iPhone/iPad 验收：

1. 正式 HTTPS 登录现有账户，确认原有 Google/Owner/节点数据仍在。
2. 未启用模块/未信任证书时查询明确失败，不能显示已保存。
3. 自行安装获授权原版模块与证书后查询；浏览器验证响应由自己模块拦截。
4. 搜索、点选、粘贴坐标/长链，核对 WGS84/GCJ-02/BD-09。
5. 保存并回读；打开实际地图 App 核验地点、精度和当前 iOS 兼容性。
6. 收藏、刷新页面、另一用户隔离；切换地点后再次保存，无须重装模块。
7. 清除并回读为空；恢复静态默认或停用模块后，核验实际真实位置。
8. iPhone 竖屏、iPad 分屏和软键盘情况下滚动表单提交，未遮挡/无横溢。

## 自动测试与 Muse 发布清单

本地 shell 受到执行器 bwrap 限制，未运行任何本地测试；GitHub Actions 使用隔离测试库/容器。
单元覆盖转换、链接域名/CRS/顺序、限流/缓存/失败、重定向、设备协议、读回不匹配、超时、零坐标。
API 集成覆盖真实数据库收藏持久化、跨用户访问、Viewer、CSRF 与 Origin；搜索上游为合成夹具。
浏览器覆盖 375/390/430/768/1440px、深浅主题、地图事件、真实收藏 API、
搜索交互及设备拦截夹具。截图明确包含 TEST TILE，模拟响应不代表真实地图服务或真机定位成功。
完整 CI 保留原有类型、Lint、格式、安全扫描、依赖审计、Google/Owner 回归、
三浏览器五项目、Docker HTTPS/CORS/CSRF、生产启动与备份恢复测试。
每项真实结果须对应交付 SHA 的 Actions 记录；本说明不预先宣称通过。

只向 Muse 交付候选 SHA/PR/CI 证据；不得由 Codex 直接操作 AWS。
Muse 必须审核本 SHA 并取得生产批准后，使用既有部署锁/备份/验证脚本。
新增 CSP 仅允许两台 Apple 配置主机连接与 OSM 瓦片图片；需重建 Web 镜像。
两个正式域名不变、不新增公开服务或端口，4000/5432 保持 Docker 内部。
现有 .env.production 保留；新搜索选项可默认或按获批供应商设置，不触碰原密钥。
生产验收包括正常 TLS、Google 登录、Owner、私有收藏、真实地图与搜索、
设备失败提示和实际 iOS 读回；物理定位效果另列，不能以 CI 代替。
