export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrfPromise: Promise<string> | null = null;
export async function csrf(): Promise<string> {
  if (!csrfPromise)
    csrfPromise = fetch("/api/v1/auth/csrf", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("无法初始化安全会话");
        return (await r.json()).csrf_token as string;
      })
      .catch((e) => {
        csrfPromise = null;
        throw e;
      });
  return csrfPromise;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (method !== "GET") headers["X-CSRF-Token"] = await csrf();
  const url = path.startsWith("/v2/") ? "/api" + path : "/api/v1" + path;
  const r = await fetch(url, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    if (
      r.status === 403 &&
      retry &&
      method !== "GET" &&
      typeof data.detail === "string" &&
      data.detail.includes("CSRF")
    ) {
      csrfPromise = null;
      return api<T>(path, method, body, false);
    }
    if (r.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      r.status,
      typeof data.detail === "string"
        ? data.detail
        : "请求未通过验证，请检查输入",
    );
  }
  return data as T;
}
export type StreamEvent = {
  name: string;
  data: { text?: string; run_id?: string; status?: string; error?: string };
};
export async function chatStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
) {
  const r = await fetch("/api/v2" + path, {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": await csrf(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r.json();
    throw new ApiError(
      r.status,
      typeof data.detail === "string" ? data.detail : "请求失败",
    );
  }
  const reader = r.body?.getReader();
  if (!reader) throw new Error("此浏览器不支持流式读取");
  const decoder = new TextDecoder();
  let buffer = "",
    completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const name =
          frame
            .split("\n")
            .find((l) => l.startsWith("event: "))
            ?.slice(7) ?? "message";
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) onEvent({ name, data: JSON.parse(data) });
        if (name === "done") completed = true;
      }
    }
    if (!completed)
      throw new Error(
        "连接中断，已完成的消息可从历史记录恢复；不要重复发送计费请求",
      );
  } finally {
    reader.releaseLock();
  }
}
