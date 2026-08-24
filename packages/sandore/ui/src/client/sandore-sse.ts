/**
 * Sandore SSE 客户端订阅器。
 *
 * 用 EventSource 连接 `/sandore/events`，接收引擎推送的 sandore/* 事件。
 * 模块级单例（多个组件共享一个 EventSource 连接）。
 */

type EventListener = (type: string, data: unknown) => void;

let source: EventSource | undefined;
let refCount = 0;
const listeners = new Set<EventListener>();

function ensureConnected(): void {
  if (source !== undefined) return;
  source = new EventSource('/sandore/events');
  // 连接建立/重连时通知监听器触发全量刷新（补偿断线期间丢失的事件）
  source.addEventListener('open', () => {
    for (const listener of listeners) {
      try { listener('__connected__', null) } catch {}
    }
  });
  source.addEventListener('message', (e: MessageEvent) => {
    try {
      // 帧格式 { type, data }：type = 事件名，data = 载荷对象（当前为 { args: [...] }）。
      const payload = JSON.parse(e.data) as { type: string; data: unknown };
      for (const listener of listeners) {
        try {
          listener(payload.type, payload.data);
        } catch {
          // 单个监听器异常不影响其他监听器
        }
      }
    } catch {
      // JSON 解析失败忽略
    }
  });
}

/**
 * 订阅 sandore SSE 事件。
 *
 * @param listener - 事件回调（type 事件名 + data 载荷对象）。
 * @returns unsubscribe 函数。
 */
export function subscribeSandoreSse(listener: EventListener): () => void {
  listeners.add(listener);
  refCount++;
  ensureConnected();
  return () => {
    listeners.delete(listener);
    refCount--;
    if (refCount <= 0 && source !== undefined) {
      source.close();
      source = undefined;
      refCount = 0;
    }
  };
}
