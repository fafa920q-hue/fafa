import { Link } from 'react-router-dom';
import { AuthLegal } from './AuthUI';
export function AuthPolicy({ privacy = false }: { privacy?: boolean }) {
  return (
    <article className="fields auth-policy">
      <h1>{privacy ? '隐私政策' : '用户协议'}</h1>
      <p>FAFA ONE · 账户与服务使用说明</p>
      {privacy ? (
        <>
          <h2>账户与验证</h2>
          <p>
            注册需要用户名、邮箱和密码。邮箱用于账户验证、安全通知和密码恢复；密码通过安全哈希存储。
          </p>
          <h2>业务数据与安全</h2>
          <p>
            账户、权限、节点授权及业务记录保存在本站服务器数据库中。邮件通过
            Resend
            发送。系统记录登录及权限变更等安全审计信息，管理员可在授权范围内管理用户与服务。
          </p>
          <h2>保护你的凭据</h2>
          <p>
            请勿向他人提供密码、验证码、重置链接或第三方账户令牌。本站不会要求你的
            Google 或 ChatGPT 密码、浏览器 Cookie。
          </p>
        </>
      ) : (
        <>
          <h2>账户与服务</h2>
          <p>
            请使用本人可访问的邮箱注册，妥善保护登录凭据。完成邮箱验证后，新注册账户为普通用户，不获得管理员或
            Owner 权限。
          </p>
          <h2>授权范围</h2>
          <p>
            节点、订阅及平台 AI
            服务由管理员授权开放。可用范围、额度和有效期以账户中展示的实际授权为准；注册本身不代表已取得这些服务权限。
          </p>
          <h2>合理使用</h2>
          <p>
            仅连接你有权使用的服务器和账户。不得冒用他人身份、绕过权限、分享他人凭据或滥用注册和邮件接口。管理员可以暂停或撤销服务授权。
          </p>
        </>
      )}
      <Link to="/member/register">返回注册</Link>
      <Link to="/member/login">返回登录</Link>
      <AuthLegal />
    </article>
  );
}
