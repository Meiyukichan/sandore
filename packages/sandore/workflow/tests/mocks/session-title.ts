/**
 * 内存 mock sessionTitle（测试专用，非发布面）。
 *
 * 提供 `rename` 等价语义：记录每次调用（session + title），支持「可编程抛错」
 * 模拟服务异常/标题被拒。以 `ctx.provide('sessionTitle', …)` 注入。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/session-title
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title';

/** 一次 `rename` 调用的入参记录。 */
export interface RenameCall {
  readonly session: Session;
  readonly title: string;
}

/** 内存 mock sessionTitle：记录调用并支持可编程抛错。 */
export class FakeSessionTitle {
  /** 每次 `rename` 调用的入参记录。 */
  readonly calls: RenameCall[] = [];
  /** 若设置，`rename` 抛出该错误（模拟服务异常/标题被拒）。 */
  renameError?: Error;

  rename(session: Session, title: string): SessionTitleSnapshot {
    this.calls.push({ session, title });
    if (this.renameError !== undefined) {
      throw this.renameError;
    }
    return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: 0 };
  }
}
