export function SetupGuide() {
  return (
    <details className="wloc-guide">
      <summary>小火箭安装、验证与恢复真实定位</summary>
      <p className="callout">
        实验性功能：网络定位响应调整不等于修改GPS。上游报告部分iOS
        18/26设备拦截失败，iOS 27 beta
        6及以上有证书限制；本站尚未完成真机兼容验收，不保证所有App生效。
      </p>
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
