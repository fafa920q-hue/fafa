export function SetupGuide() {
  return (
    <details className="wloc-guide">
      <summary>小火箭安装、验证与恢复真实定位</summary>
      <p className="callout">
        实验性功能：网络定位响应调整不等于修改GPS。2026-11-04 起，多台 iOS 18/26
        设备突然无法拦截 gs-loc 域名（上游调查：系统 trustd 的 pinningrules
        被热更新，要求 Apple 签发的证书；同一张证书拦截其他域名仍正常）；iOS 27
        beta 6及以上有证书限制；本站尚未完成真机兼容验收，不保证所有App生效。
      </p>
      <details>
        <summary>iOS 26.3 / 2026-11-04 拦截失效：先确认是不是这个问题</summary>
        <ol>
          <li>
            在 Safari 直接打开 https://gs-loc.apple.com/ ：只看到 404“Not
            Found”不能单独确认钉扎问题——那是 Apple 真实服务器对普通 GET /
            的正常返回。若提示“证书无效 /
            未受信任”或无法建立安全连接，才说明系统已拒绝该域名的 MITM
            证书（模块、证书、代理本身都没有问题，是系统规则变了）。
          </li>
          <li>
            查看“设置 → 通用 → 关于本机”中的受信任资产版本：1014
            已确认受影响，1013 仍可用。两者都可能随系统后台更新而变化。
          </li>
          <li>
            若确认是证书被拒：换代理工具、换软路由、换网关透明代理同样无效，因为校验发生在设备内部的
            locationd /
            trustd，不在流量路径上。不要关闭系统安全设置、不要降低服务器 TLS
            验证。真实可行的办法只有一个：恢复出厂设置回到
            1013，再立刻屏蔽资产下发通道，详见下方“解决方法”。Xcode
            开发者模式可以临时虚拟定位，但系统会标记为模拟定位，部分 App
            可以识别，本站不提供该方式。
          </li>
          <li>
            即使模块拦截恢复：iOS 26
            起系统会缓存真实定位结果并长时间复用，保存成功后仍可能显示旧坐标，需要重启设备清缓存。但
            2026-11-04
            后重启有风险——有用户反馈重启后拦截直接失效（重启也会触发资产检查），重启前请先确认上面两步。
          </li>
        </ol>
        <h4>原因：2026-11-04 苹果加了证书钉扎</h4>
        <ul>
          <li>
            2026-11-04，Apple 经系统 trustd 后台热更新了
            pinningrules.sqlite3，对 gs-loc.apple.com / gs-loc-cn.apple.com 加了
            AppleIssued 证书钉扎校验：只有 Apple 根签发的证书才被接受，非 Apple
            CA 的 MITM 证书会被拒绝（错误 -67880）。
          </li>
          <li>
            这是 MobileAsset PKITrustStore 资产更新：受信任资产版本 1014
            已确认受影响，1013 仍可用。它不是随 iOS 系统更新下发的，而是经
            trustd 后台单独推送的“受信任资产”更新，与 iOS
            版本号无关，关自动更新也拦不住。下发端点是 gdmf.apple.com/v2/assets
            与 updates.cdn-apple.com；检查周期每 7 天一次，重启也会触发。
          </li>
          <li>
            证据：上游 Yu9191/wloc README 2026-11-04 更新；Issue
            #130（2026-11-04 11:04:46 trustd 更新
            pinningrules.sqlite3，恢复旧文件可恢复 MITM）；Issue #123（多名用户
            11/4 当天突然失效，已确认 1014 受影响、1013 仍可用）。本机已确认是
            1014（受影响）。
          </li>
          <li>
            诚实区分：本站的检测逻辑是正确的——按原版模块协议要求 response.ok +
            JSON success
            布尔值；“未检测到代理模块”是该判定在正常工作，不是误判。“坐标已保存”只说明模块配置回读成功，不等于
            iPhone 实际定位已修改，须用真实地图 App 核验。
          </li>
        </ul>
        <h4>解决方法：目前唯一真实可行的路</h4>
        <ol>
          <li>恢复出厂设置，回到受信任资产 1013。</li>
          <li>
            恢复后立刻屏蔽 1014 资产下发通道，再让手机联网。须屏蔽的 6
            个域名（路由器拦截 + 小火箭 REJECT
            规则，两层封堵）：gdmf.apple.com、gdmf-ados.apple.com、mesu.apple.com、updates.cdn-apple.com、updates-http.cdn-apple.com、appldnld.apple.com。也可以加
            allowOTAPKIUpdates=false 描述文件作辅助，但实测单独无效。
          </li>
          <li>
            重新装回模块并核验：先确认“受信任资产版本”仍是 1013，再用真实地图
            App 核验定位是否真的变了。
          </li>
          <li>
            亲测情况：多人在 iOS 26.6.1 / 26.6.2、iOS 16.7.16、iOS 15.8.8
            上成功；iOS 26.3 上无人直接报成功，但机制上应同样适用（26.3
            内置的资产必然早于 2026-11-04 推送的 1014）。
          </li>
        </ol>
        <h4>代价与风险：做之前一定要看清</h4>
        <ul>
          <li>必须抹掉整台手机，再从备份恢复（备份里不含 1014）。</li>
          <li>
            屏蔽须覆盖手机用到的每一个网络：家里 / 公司 WiFi、流量、USB
            连电脑。任何一次漏网，都可能在 7 天检查周期内被重新推到
            1014，漏一次就要再恢复出厂一次。
          </li>
          <li>
            副作用：天气降雨通知可能停推；App Store /
            系统应用下载可能受阻；mesu.apple.com 被屏蔽会影响钱包加卡。
          </li>
          <li>
            长期稳定性尚未证实：最长观察仅约 48 小时，7 天检查周期还未跑满。
          </li>
        </ul>
        <h4>这些办法行不通，别白试了</h4>
        <ul>
          <li>直接恢复 pinningrules.sqlite3：需要 root / 越狱权限。</li>
          <li>降级 iOS：全部 iOS 26 构建已停止签名，包括 26.3。</li>
          <li>iOS 26.3 公开越狱：不存在。</li>
        </ul>
        <h4>切勿</h4>
        <ul>
          <li>升到 iOS 27：其镜像已内置该规则，恢复出厂也回不去 1013。</li>
          <li>相信网上声称支持 iOS 26.3 越狱的工具。</li>
          <li>在没有封堵的情况下恢复出厂：几小时到几天内会被重新推到 1014。</li>
        </ul>
        <h4>替代品：恢复不了 wloc 的临时办法</h4>
        <ul>
          <li>
            Xcode / LocWarp
            开发者模拟定位：临时、需连电脑，isSimulatedBySoftware=true
            会被钉钉类 App 识别。
          </li>
          <li>硬件 GPS 欺骗器：贵，并会被识别为外接设备。</li>
        </ul>
        <p>
          参考：
          <a
            href="https://github.com/Yu9191/wloc"
            target="_blank"
            rel="noreferrer"
          >
            上游 Yu9191/wloc
          </a>
          （Issue{' '}
          <a
            href="https://github.com/Yu9191/wloc/issues/130"
            target="_blank"
            rel="noreferrer"
          >
            #130
          </a>
          、Issue{' '}
          <a
            href="https://github.com/Yu9191/wloc/issues/123"
            target="_blank"
            rel="noreferrer"
          >
            #123
          </a>
          ）
        </p>
      </details>
      <ol>
        <li>
          仅在本人获授权的设备使用。阅读
          <a
            href="https://github.com/Yu9191/wloc"
            target="_blank"
            rel="noreferrer"
          >
            原版说明、许可证和兼容性
          </a>
          ；商业使用须核实上游授权。将
          <a
            href="https://raw.githubusercontent.com/Yu9191/wloc/refs/heads/main/modules/wloc.module"
            target="_blank"
            rel="noreferrer"
          >
            原版WLOC模块地址
          </a>
          复制到Shadowrocket的模块管理并启用。该模块引用上游main脚本，可能随上游更新。
        </li>
        <li>
          在Shadowrocket中启用HTTPS解密，按原版模块添加以下主机（不要添加通配符）：
          <code>gs-loc.apple.com</code>、<code>gs-loc-cn.apple.com</code>、
          <code>gsp-ssl.ls.apple.com</code>、
          <code>bluedot.is.autonavi.com</code>、
          <code>bluedot.is.autonavi.com.gds.alibabadns.com</code>。
        </li>
        <li>
          由你本人在Shadowrocket生成证书，安装描述文件，并在iOS“设置 → 通用 →
          关于本机 → 证书信任设置”中确认是否信任。
          <a
            href="https://support.apple.com/102390"
            target="_blank"
            rel="noreferrer"
          >
            Apple证书信任说明
          </a>
          。证书具有HTTPS解密能力，仅信任你自己生成并了解用途的证书；网页不会操作系统信任或索取证书私钥。
        </li>
        <li>
          开启Shadowrocket，回到本页“查询设备配置”。选点后点击“保存到设备”。此操作只发给当前手机的原版模块，不会让AWS写入手机。
        </li>
        <li>
          收到保存并回读一致提示后，打开实际地图App，按当前iOS版本和上游说明刷新定位，检查地点和精度。设备保存成功仍不能证明系统定位生效。未安装证书、模块未启用、CORS或iOS限制都可能造成请求失败；不要关闭服务器TLS验证或降低系统安全设置。
        </li>
        <li>
          恢复：先“清除设备配置”并确认回读为空。原版模块默认静态坐标表示不修改；如果你改过模块静态坐标，须恢复默认参数或停用模块。需要完全停止WLOC处理时关闭该模块，再在真实地图App中重新请求定位，等待系统缓存更新并核验真实位置；不保证清除网页配置后立即恢复。
        </li>
      </ol>
      <p>
        无须每次重装模块：安装完成后可在本页收藏、切换和保存地点。仅使用Apple
        Wi-Fi/基站定位响应的应用可能受影响；真实iPhone/iPad验收须由设备持有人执行。
      </p>
    </details>
  );
}
