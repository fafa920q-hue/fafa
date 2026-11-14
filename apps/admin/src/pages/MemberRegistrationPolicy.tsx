import { useState } from 'react';
import {
  ChevronDown,
  Clock3,
  Cpu,
  Gift,
  Mail,
  Save,
  ShieldCheck,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import type { ServicePolicy } from '../../../../packages/auth/src/service-policy';
import {
  DataState,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';
import { AccessActivityForm, type Activity } from './AccessActivities';
import { MemberDeliveryAdmin, MemberMailStatus } from './MemberDeliveryAdmin';
import { ServicePolicyAdmin } from './ServicePolicyAdmin';
import './member-registration.css';

type RegistrationPolicy = {
  enabled: boolean;
  seatLimit: number;
  mailConfigured: boolean;
  recentMailFailures: number;
};
type Status = { label: string; tone?: 'positive' | 'notice' };
const panels = [
  {
    id: 'registration',
    title: '自由注册设置',
    icon: UserRoundPlus,
    description: '管理公开注册、账户席位和邮箱验证设置。',
  },
  {
    id: 'trial',
    title: '注册体验策略',
    icon: Gift,
    description: '设置新用户的体验资格、有效时长及适用范围。',
  },
  {
    id: 'campaign',
    title: '全站限时开放',
    icon: Clock3,
    description: '按服务时段开放指定功能，可面向全部或指定普通用户。',
  },
  {
    id: 'ai',
    title: 'AI 服务管理',
    icon: Cpu,
    description: '设置平台 AI 服务的开放范围、期限、调用次数和并发。',
  },
] as const;
type PanelId = (typeof panels)[number]['id'];

function activityStatus(
  data: Activity | undefined,
  error: string,
  trial: boolean,
): Status {
  if (error) return { label: '读取失败', tone: 'notice' };
  if (!data) return { label: '读取中' };
  if (!data.enabled) return { label: '未开启' };
  if (!trial && data.mode === 'WINDOW_ONLY')
    return { label: '原服务时段已启用', tone: 'notice' };
  if (data.paused) return { label: '已暂停', tone: 'notice' };
  const starts = Date.parse((trial ? data.windowStart : data.startsAt) || '');
  const ends = Date.parse((trial ? data.windowEnd : data.endsAt) || '');
  const now = Date.now();
  if (now < starts) return { label: '已配置 · 待开始', tone: 'notice' };
  if (now >= ends) return { label: '已结束' };
  return { label: '已配置 · 进行中', tone: 'positive' };
}

function StatusLabel({ status }: { status: Status }) {
  return (
    <span className="reg-status" data-tone={status.tone}>
      {status.label}
    </span>
  );
}

export function MemberRegistrationPolicy() {
  const policy = useData<RegistrationPolicy>('/api/admin/member-registration');
  const seats = useData<{ seats: number | null }>('/api/summary');
  const trial = useData<Activity>('/api/admin/access/trial-policy');
  const campaign = useData<Activity>('/api/admin/access/campaign');
  const service = useData<ServicePolicy>('/api/admin/service-policy');
  const [open, setOpen] = useState<PanelId | null>('registration');
  const ai = service.data?.ai;
  const statuses: Record<PanelId, Status> = {
    registration: policy.error
      ? { label: '读取失败', tone: 'notice' }
      : policy.data?.enabled
        ? { label: '已开启', tone: 'positive' }
        : { label: policy.data ? '已关闭' : '读取中' },
    trial: activityStatus(trial.data, trial.error, true),
    campaign: activityStatus(campaign.data, campaign.error, false),
    ai: service.error
      ? { label: '读取失败', tone: 'notice' }
      : ai?.enabled && ai.until && Date.parse(ai.until) <= Date.now()
        ? { label: '已到期' }
        : ai?.enabled
          ? { label: '已开启', tone: 'positive' }
          : { label: ai ? '未开启' : '读取中' },
  };
  const overview = [
    { label: '注册状态', icon: UserRoundPlus, status: statuses.registration },
    { label: '已注册用户', icon: Users, count: true },
    { label: '体验资格活动', icon: Gift, status: statuses.trial },
    { label: '全站限时开放', icon: Clock3, status: statuses.campaign },
  ];
  const content = {
    registration: <RegistrationSettings policy={policy} />,
    trial: (
      <>
        <AccessActivityForm trial settings={trial} />
        <MemberDeliveryAdmin />
      </>
    ),
    campaign: (
      <AccessActivityForm
        trial={false}
        settings={campaign}
        onSaved={service.refresh}
      />
    ),
    ai: <ServicePolicyAdmin policy={service} onSaved={campaign.refresh} />,
  };
  return (
    <div className="registration-policy">
      <PageTitle
        title="普通账户注册"
        description="注册账户默认 Member，必须实际验证邮箱；停用账户和撤销会话继续使用用户管理。"
      />
      <section className="reg-overview" aria-label="注册及活动概览">
        {overview.map(({ label, icon: Icon, status, count }) => (
          <div className="glass reg-metric" key={label}>
            <span className="card-icon">
              <Icon size={22} aria-hidden="true" />
            </span>
            <div>
              <strong>{label}</strong>
              {count ? (
                <>
                  <div className="reg-seat-count">
                    {seats.error ? '读取失败' : (seats.data?.seats ?? '—')}{' '}
                    <span>/ {policy.data?.seatLimit ?? '—'}</span>
                  </div>
                  <small>全站注册席位</small>
                </>
              ) : (
                status && <StatusLabel status={status} />
              )}
            </div>
          </div>
        ))}
      </section>
      <nav className="glass reg-nav" aria-label="注册设置分区">
        {panels.map(({ id, title, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-controls={'reg-panel-' + id}
            aria-expanded={open === id}
            onClick={() => setOpen(id)}
          >
            <Icon size={19} aria-hidden="true" />
            <span>{title}</span>
          </button>
        ))}
      </nav>
      <div className="reg-sections">
        {panels.map(({ id, title, description, icon: Icon }) => (
          <section
            className="glass reg-section"
            key={id}
            data-open={open === id}
          >
            <h2 aria-labelledby={'reg-title-' + id}>
              <button
                type="button"
                className="reg-section-toggle"
                aria-labelledby={'reg-title-' + id}
                aria-controls={'reg-panel-' + id}
                aria-expanded={open === id}
                onClick={() => setOpen(open === id ? null : id)}
              >
                <span className="card-icon">
                  <Icon size={22} aria-hidden="true" />
                </span>
                <span className="reg-section-copy">
                  <strong id={'reg-title-' + id}>{title}</strong>
                  <small>{description}</small>
                </span>
                <StatusLabel status={statuses[id]} />
                <ChevronDown
                  className="reg-chevron"
                  size={18}
                  aria-hidden="true"
                />
              </button>
            </h2>
            <div
              className="reg-section-body"
              id={'reg-panel-' + id}
              hidden={open !== id}
            >
              {content[id]}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function RegistrationSettings({
  policy,
}: {
  policy: ReturnType<typeof useData<RegistrationPolicy>>;
}) {
  const { request, session, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const settings = policy.data;
  const readOnly = session.user.role !== 'Owner';
  return (
    <>
      <DataState
        error={policy.error}
        loading={!settings}
        onRetry={policy.refresh}
      />
      {settings && (
        <form
          className="fields reg-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const form = new FormData(event.currentTarget);
            setBusy(true);
            try {
              await request('/api/admin/member-registration', 'PATCH', {
                enabled: form.get('enabled') === 'on',
                seatLimit: Number(form.get('seatLimit')),
              });
              policy.refresh();
              toast('注册策略已保存');
            } catch {
              // The shared request handler displays API errors.
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset
            className="reg-registration-grid"
            disabled={readOnly || busy}
          >
            <div className="reg-column">
              <label className="reg-registration-switch">
                <span>
                  <strong>允许自由注册</strong>
                  <small>开启后，用户可在前台自行注册账户。</small>
                </span>
                <input
                  key={String(settings.enabled)}
                  name="enabled"
                  type="checkbox"
                  role="switch"
                  defaultChecked={settings.enabled}
                />
              </label>
              <label>
                <span>注册人数上限（所有有效用户共用）</span>
                <input
                  key={settings.seatLimit}
                  name="seatLimit"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={settings.seatLimit}
                  required
                />
              </label>
            </div>
            <div className="reg-column reg-verification">
              <div>
                <strong>邮箱验证方式</strong>
                <div className="reg-fixed-field">
                  <ShieldCheck size={16} aria-hidden="true" /> 邮箱验证码{' '}
                  <small>固定流程</small>
                </div>
              </div>
              <p>新用户需收到并验证邮箱验证码后，才能完成注册。</p>
            </div>
          </fieldset>
          <details className="reg-mail">
            <summary>
              <span className="card-icon">
                <Mail size={19} aria-hidden="true" />
              </span>
              <span className="reg-mail-copy">
                <strong>邮件发送状态</strong>
                <small>
                  {settings.mailConfigured
                    ? '邮件服务已配置'
                    : '邮件服务未配置，禁止开启自由注册'}{' '}
                  · 最近一小时发送失败 {settings.recentMailFailures} 次
                </small>
              </span>
              <span className="reg-mail-action">
                查看邮件记录 <ChevronDown size={15} aria-hidden="true" />
              </span>
            </summary>
            <MemberMailStatus />
          </details>
          <div className="reg-save">
            {readOnly && <small>仅 Owner 可保存自由注册设置。</small>}
            <button className="primary" disabled={readOnly || busy}>
              <Save size={16} aria-hidden="true" />
              {busy ? '保存中…' : '保存自由注册设置'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
