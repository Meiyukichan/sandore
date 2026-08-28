/**
 * Sandore SSE 事件通道（host 侧）。
 *
 * 注册 `/sandore/events` 端点，广播 sandore/* 事件给所有连接的客户端。
 * 替代短轮询，实现即时 UI 刷新。
 */
import type { Context } from '@deepseek-ai/cordis';

/** 最小 HTTP response 面（避免 import node:http，保持 browser-safe 类型）。 */
interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  write(data: string): boolean;
  end(): void;
  destroy(): void;
  on(event: string, listener: () => void): void;
}

/** SSE 帧格式化（data 行 JSON，双换行结束）。 */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 事件名称白名单（sandore 自有事件词表）。 */
const SANDBORE_EVENTS = [
  'sandore/start',
  'sandore/stage-start',
  'sandore/stage-completed',
  'sandore/step-start',
  'sandore/step-completed',
  'sandore/step-failed',
  'sandore/step-paused',
  'sandore/step-resumed',
  'sandore/step-retried',
  'sandore/step-phase',
  'sandore/step-message',
  'sandore/end',
  'sandore/aborted',
  'sandore/question',
  'sandore/permission',
  'sandore/question_rejected',
] as const;

/**
 * 注册 Sandore SSE 事件通道。
 *
 * 在 webServer 上注册 `/sandore/events` 路由，维护连接集合，
 * 订阅所有 sandore/* 事件并广播给已连接客户端。
 *
 * @returns dispose 函数（移除路由 + 订阅 + 关闭连接）。
 */
export function registerSandoreSse(ctx: Context): () => void {
  const connections = new Set<ServerResponseLike>();
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'exact'; path: string; handler: (req: unknown, res: ServerResponseLike) => void }): () => void }
    | undefined;
  if (webServer === undefined) {
    ctx.logger.warn('sandore: webServer not available, SSE channel disabled');
    return () => {};
  }

  const connect = (res: ServerResponseLike): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    // 注释行：让客户端/代理看到活跃通道（EventSource 帧解析跳过注释）。
    res.write(': connected\n\n');
    connections.add(res);
    res.on('close', () => { connections.delete(res); });
  };

  const broadcast = (event: string, ...args: unknown[]): void => {
    // 帧格式统一为 { type, data }：type = 事件名，data = 载荷对象（args 保留完整位置参数列表，
    // 后续可按事件扩展结构化字段）。
    const line = sseData({ type: event, data: { args } });
    for (const res of connections) {
      res.write(line);
    }
  };

  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/sandore/events',
    handler: (req, res) => {
      if ((req as { method?: string }).method !== 'GET' && (req as { method?: string }).method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      connect(res);
    },
  });

  // 订阅所有 sandore/* 事件并广播。
  const disposers: Array<() => void> = [];
  for (const eventName of SANDBORE_EVENTS) {
    const dispose = ctx.on(eventName as 'sandore/start', ((...args: unknown[]) => {
      broadcast(eventName, ...args);
    }) as (...args: unknown[]) => void);
    disposers.push(dispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
    disposeRoute();
    for (const res of connections) res.destroy();
    connections.clear();
  };
}
