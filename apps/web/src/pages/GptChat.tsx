import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import highlight from 'rehype-highlight';
import { backendUrl } from '../../../../packages/ui/src/endpoints';
import {
  Card,
  ConfirmDialog,
  DataState,
  Empty,
  FormDialog,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';
import type { PlatformService } from './PlatformGpt';
import './gpt-chat.css';

type Conversation = { id: string; title: string };
type Message = {
  id: string;
  prompt: string;
  output: string;
  model: string;
  status: string;
  error?: string;
  retryOf?: string;
};
type Thread = Conversation & { messages: Message[] };
const active = (status?: string) => status === 'QUEUED' || status === 'RUNNING';

export function GptChat() {
  const service = useData<PlatformService>('/api/ai/platform');
  useEffect(() => {
    if (!service.data?.mode) return;
    const timer = setInterval(service.refresh, 20000);
    return () => clearInterval(timer);
  }, [service.data?.mode]);
  return (
    <>
      <PageTitle
        title="GPT 对话"
        description="使用管理员开放的模型，按当前账户额度结算。"
      />
      <DataState
        error={service.error}
        loading={!service.data}
        onRetry={service.refresh}
      />
      {service.data?.mode ? (
        <ChatWorkspace service={service} />
      ) : (
        service.data && (
          <Card title="平台 GPT 服务">
            <Empty title="服务尚未开放" />
          </Card>
        )
      )}
    </>
  );
}

function ChatWorkspace({
  service,
}: {
  service: ReturnType<typeof useData<PlatformService>>;
}) {
  const { request, toast } = useApp();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [rename, setRename] = useState<Conversation>();
  const [remove, setRemove] = useState<Conversation>();
  const [creating, setCreating] = useState(false);
  const list = useData<Conversation[]>(
    '/api/ai/chats?q=' + encodeURIComponent(query),
  );
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  return (
    <div className="gpt-layout">
      <Card
        title="对话历史"
        action={
          <button
            disabled={creating}
            onClick={async () => {
              setCreating(true);
              try {
                const chat = await request<Conversation>(
                  '/api/ai/chats',
                  'POST',
                  {},
                );
                setSelected(chat.id);
                setSearch('');
                list.refresh();
              } catch (error) {
                toast((error as Error).message);
              } finally {
                setCreating(false);
              }
            }}
          >
            新建对话
          </button>
        }
      >
        <label>
          搜索对话
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
          />
        </label>
        <DataState
          error={list.error}
          loading={!list.data}
          onRetry={list.refresh}
        />
        <div className="gpt-history">
          {list.data?.map((chat) => (
            <div className="gpt-history-item" key={chat.id}>
              <button
                type="button"
                aria-pressed={selected === chat.id}
                className={selected === chat.id ? 'primary' : ''}
                onClick={() => setSelected(chat.id)}
              >
                {chat.title}
              </button>
              <div className="actions">
                <button type="button" onClick={() => setRename(chat)}>
                  重命名
                </button>
                <button type="button" onClick={() => setRemove(chat)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {list.data?.length === 0 && <p className="muted">暂无匹配对话</p>}
        </div>
      </Card>
      {selected ? (
        <ChatThread
          key={selected}
          id={selected}
          service={service}
          onSent={list.refresh}
        />
      ) : (
        <Card title="对话">
          <Empty title="新建对话或选择历史记录" />
        </Card>
      )}
      <FormDialog
        open={!!rename}
        onClose={() => setRename(undefined)}
        title="重命名对话"
        fields={[
          {
            name: 'title',
            label: '对话标题',
            value: rename?.title,
            required: true,
          },
        ]}
        onSubmit={async (d) => {
          await request('/api/ai/chats/' + rename!.id, 'PATCH', d);
          list.refresh();
        }}
      />
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(undefined)}
        title="删除对话"
        description="删除后无法从对话历史打开，正在运行的回复也会停止。"
        onConfirm={async () => {
          await request('/api/ai/chats/' + remove!.id, 'DELETE');
          if (selected === remove!.id) setSelected(undefined);
          list.refresh();
        }}
      />
    </div>
  );
}

function ChatThread({
  id,
  service,
  onSent,
}: {
  id: string;
  service: ReturnType<typeof useData<PlatformService>>;
  onSent: () => void;
}) {
  const { request, toast } = useApp();
  const url = '/api/ai/chats/' + id;
  const thread = useData<Thread>(url);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attachment, setAttachment] = useState<{
    name: string;
    text: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{
    id: string;
    output: string;
    status: string;
  }>();
  const [submitted, setSubmitted] = useState<string>();
  const retry = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const sending = useRef(false);
  const choices = service.data?.catalog ?? [];
  const selected = choices.some((m) => m.id === model)
    ? model
    : ((choices.find((m) => m.default) ?? choices[0])?.id ?? '');
  const messages = thread.data?.messages ?? [];
  const last = messages.at(-1);
  const streaming = submitted || (active(last?.status) ? last?.id : undefined);
  useEffect(() => {
    if (!streaming) return;
    const source = new EventSource(
      backendUrl('/api/ai/tasks/' + streaming + '/events'),
      { withCredentials: true },
    );
    const refresh = () => {
      thread.refresh();
      service.refresh();
    };
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLive({
        id: streaming,
        output: data.output || '',
        status: data.status,
      });
      if (!active(data.status)) {
        source.close();
        setSubmitted(undefined);
        refresh();
      }
    };
    source.onerror = () => {
      source.close();
      setSubmitted(undefined);
      refresh();
    };
    return () => source.close();
  }, [streaming]);
  async function send(retryOf?: string) {
    if (
      !selected ||
      streaming ||
      sending.current ||
      (!retryOf && !prompt.trim())
    )
      return;
    const signature = JSON.stringify([
      selected,
      retryOf,
      prompt.trim(),
      attachment,
    ]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, id: crypto.randomUUID() };
    sending.current = true;
    setBusy(true);
    try {
      const task = await request<{ id: string }>(url + '/messages', 'POST', {
        model: selected,
        requestId: retry.current.id,
        ...(retryOf ? { retryOf } : { prompt, attachment }),
      });
      retry.current = undefined;
      setLive(undefined);
      setSubmitted(task.id);
      setPrompt('');
      setAttachment(undefined);
      thread.refresh();
      service.refresh();
      onSent();
    } catch (error) {
      toast((error as Error).message);
      service.refresh();
    } finally {
      setBusy(false);
      sending.current = false;
    }
  }
  return (
    <Card title={thread.data?.title ?? '对话'}>
      <DataState
        error={thread.error}
        loading={!thread.data}
        onRetry={thread.refresh}
      />
      {service.data?.quota && (
        <p className="muted">
          今日剩余 USD {(service.data.quota.daily / 1_000_000).toFixed(6)}
        </p>
      )}
      <div className="gpt-model-bar" role="group" aria-label="选择对话模型">
        <label className="gpt-model-picker">
          <span>模型</span>
          <select
            value={selected}
            onChange={(e) => setModel(e.target.value)}
            disabled={!!streaming || !choices.length}
            aria-label="选择对话模型"
          >
            {!choices.length && <option value="">暂无已授权模型</option>}
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="gpt-model-meta">
          {choices.length
            ? `${choices.length} 个可用模型 · 切换后用于后续对话`
            : '暂无已授权模型，请联系管理员'}
        </span>
        <Link className="gpt-model-quota" to="/ai/quota">
          我的额度
        </Link>
      </div>
      <div className="gpt-messages" aria-label="对话消息">
        {messages.map((message) => {
          const current =
            live?.id === message.id && active(message.status)
              ? { ...message, ...live }
              : message;
          return (
            <article key={message.id} className="gpt-turn">
              <p className="gpt-question">
                {message.retryOf ? '重新生成 · ' : ''}
                {message.prompt}
              </p>
              <p className="muted">
                {message.model} ·{' '}
                {active(current.status)
                  ? '正在生成'
                  : current.status === 'COMPLETED'
                    ? '已完成'
                    : current.status === 'CANCELLED'
                      ? '已停止'
                      : '生成未完成'}
              </p>
              {current.output && (
                <>
                  <Markdown
                    skipHtml
                    disallowedElements={['img']}
                    rehypePlugins={[highlight]}
                  >
                    {current.output}
                  </Markdown>
                  <button
                    onClick={() =>
                      navigator.clipboard
                        .writeText(current.output)
                        .then(() => toast('已复制'))
                        .catch(() => toast('无法复制'))
                    }
                  >
                    复制
                  </button>
                </>
              )}
              {message.error && <p role="alert">{message.error}</p>}
              {last?.id === message.id && !active(message.status) && (
                <button
                  disabled={busy || !!streaming || !selected}
                  onClick={() => send(message.id)}
                >
                  重新生成
                </button>
              )}
            </article>
          );
        })}
        {streaming && !messages.some((m) => m.id === streaming) && (
          <p role="status">正在准备回复…</p>
        )}
      </div>
      {thread.data && (
        <form
          className="fields"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label>
            消息
            <textarea
              rows={4}
              required
              value={prompt}
              maxLength={16000}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          {service.data?.allowTextAttachments && !streaming && (
            <div className="actions">
              <label>
                文本附件（最多 8 KB）
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json,.log"
                  onChange={async (e) => {
                    const input = e.currentTarget;
                    const file = input.files?.[0];
                    input.value = '';
                    if (!file) return;
                    if (
                      file.size > 8000 ||
                      !/\.(txt|md|csv|json|log)$/i.test(file.name)
                    )
                      return toast('请选择不超过 8 KB 的文本文件');
                    try {
                      setAttachment({
                        name: file.name,
                        text: await file.text(),
                      });
                    } catch {
                      toast('无法读取附件');
                    }
                  }}
                />
              </label>
              {attachment && (
                <button type="button" onClick={() => setAttachment(undefined)}>
                  移除 {attachment.name}
                </button>
              )}
            </div>
          )}
          <div className="actions">
            <button
              className="primary"
              disabled={!selected || busy || !!streaming || !prompt.trim()}
            >
              发送
            </button>
            {streaming && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await request(
                      '/api/ai/tasks/' + streaming + '/cancel',
                      'POST',
                    );
                    setSubmitted(undefined);
                    thread.refresh();
                    service.refresh();
                  } catch (error) {
                    toast((error as Error).message);
                  }
                }}
              >
                停止生成
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}
