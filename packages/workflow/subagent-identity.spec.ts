/**
 * `ensureSubagentDescriptor` 的单元覆盖：**fork 会话里祖先身份事件不得让补写失效**。
 *
 * ## 真机缺陷（2026-09，用户现场）
 * 子代理列表里每个 step 下面都有一条「会话记录损坏」，命中的 uuid 经对账 =
 * `finalizeMeta.assessResult.forkSessionId`（收尾评估 fork）/ `routingResult.routingSessionId`
 * （判断/路由 fork）。根因：
 * 1. 这两类 fork 走 `forkStepSubagent`（裸 `agents.create` + seed）绕过 DSH subagent
 *    provider，身份事件靠引擎补写；
 * 2. 但它们的 seed 是**被 fork 的 step 子代理会话**，而那个会话的 seed[0] 就是**它自己的**
 *    `subagent/descriptor`（seq 0）—— 于是 fork 日志里天然存在一条 descriptor；
 * 3. 旧的幂等守卫「已有该类型事件就跳过」被**祖先那条**骗过 → 补写永不发生 →
 *    身份投影 fold 到祖先的 seq 0 → `seq < inheritedEventCount` → DSH 判
 *    `{kind:'diagnostic', reason:'corrupt'}` → UI「会话记录损坏」。
 *
 * 修法（本文件的被测行为）：判据改为「**最后一条** descriptor 的 seq 是否落在**自有区间**」
 * （`>= Session.firstLiveSeq`）——落在继承前缀里就追加一条自有身份；DSH 身份投影是
 * **last-wins** fold（`subagent/projection.ts:158-177`），追加后即取到自有身份。
 * @module @meiyukichan/dsh-sandore/workflow/src/subagent-identity
 */
import { describe, expect, it } from 'vitest';

import type { Context } from '@deepseek-ai/cordis';

import {
  INTERNAL_SUBAGENT_PROVIDER,
  SUBAGENT_DESCRIPTOR_EVENT,
  SUBAGENT_DESCRIPTOR_VERSION,
  ensureSubagentDescriptor,
} from './subagent-identity.ts';

/** 一条最小会话事件（只保留判定用到的 `type`/`seq`）。 */
interface FakeEvent {
  readonly type: string;
  readonly seq: number;
}

/** 假会话：`snapshotEvents` + `firstLiveSeq` + `append`（`ensureSubagentDescriptor` 的整面契约）。 */
class FakeSession {
  private readonly events: FakeEvent[];
  readonly appended: { type: string; data: unknown }[] = [];
  constructor(
    events: readonly FakeEvent[],
    /** 自有区间起点（DSH `Session.firstLiveSeq`；seeded 时 = seed.length）。 */
    readonly firstLiveSeq: number,
  ) {
    this.events = [...events];
  }

  snapshotEvents(): readonly FakeEvent[] {
    return [...this.events];
  }

  append(type: string, data: unknown): unknown {
    this.appended.push({ type, data });
    this.events.push({ type, seq: this.events.length });
    return undefined;
  }
}

/** 组装一个只提供 `sessions.get` 的 Cordis 上下文面。 */
function ctxWith(session: FakeSession | undefined): Context {
  return { get: (name: string) => (name === 'sessions' ? { get: () => session } : undefined) } as unknown as Context;
}

/** 祖先身份事件（fork seed 里重放的那条：mode=continuable、label 是被 fork 会话自己的标题）。 */
const ANCESTOR_DESCRIPTOR: FakeEvent = { type: SUBAGENT_DESCRIPTOR_EVENT, seq: 0 };

/** 普通事件（凑出 seed 长度）。 */
function filler(count: number, offset = 1): FakeEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({ type: 'user/message', seq: index + offset }));
}

describe('ensureSubagentDescriptor', () => {
  it('seeded fork：seed 里带的**祖先**身份事件不构成「已补写」，仍追加自有身份（且 seq 落在自有区间）', () => {
    // seed = [祖先 descriptor(seq0), 21 条事件] → firstLiveSeq = 22。
    const seeded = [ANCESTOR_DESCRIPTOR, ...filler(21)];
    const session = new FakeSession(seeded, seeded.length);

    const written = ensureSubagentDescriptor(ctxWith(session), 'child-1', 'assess src · child-1');

    expect(written).toBe(true);
    // 必须真的追加了一条（旧实现被祖先骗过 → appended 为空）。
    expect(session.appended).toHaveLength(1);
    const appended = session.appended[0]!;
    expect(appended.type).toBe(SUBAGENT_DESCRIPTOR_EVENT);
    // 自有身份的 seq = 追加后的位置（= seed 长度）→ DSH `identity.seq >= inheritedEventCount` 成立。
    const own = session.snapshotEvents().at(-1)!;
    expect(own.seq).toBe(seeded.length);
    expect(own.seq >= session.firstLiveSeq).toBe(true);
    // 载荷：DSH 当前版本 + 一次性语义 + 引擎 provider 标记 + 可读 label。
    expect(appended.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: INTERNAL_SUBAGENT_PROVIDER,
      label: 'assess src · child-1',
    });
  });

  it('幂等：已有**自有**身份（seq 落在自有区间）时不重复追加', () => {
    // seed 2 条 + 自有 descriptor(seq2) → firstLiveSeq = 2。
    const session = new FakeSession([...filler(2, 0), { type: SUBAGENT_DESCRIPTOR_EVENT, seq: 2 }], 2);

    expect(ensureSubagentDescriptor(ctxWith(session), 'child-2', 'assess src · child-2')).toBe(true);
    expect(session.appended).toHaveLength(0);
  });

  it('provider 建的子代理（无 seed、身份在 seq0）：firstLiveSeq=0 → 视为自有，不重复补写', () => {
    const session = new FakeSession([{ type: SUBAGENT_DESCRIPTOR_EVENT, seq: 0 }, ...filler(3)], 0);

    expect(ensureSubagentDescriptor(ctxWith(session), 'child-3', 'gate src · child-3')).toBe(true);
    expect(session.appended).toHaveLength(0);
  });

  it('无身份事件的普通会话（重试 fork 之外的路径）：补写一条自有身份', () => {
    const session = new FakeSession(filler(5), 5);

    expect(ensureSubagentDescriptor(ctxWith(session), 'child-4', 'retry src · child-4')).toBe(true);
    expect(session.appended).toHaveLength(1);
    expect(session.snapshotEvents().at(-1)!.seq).toBe(5);
  });

  it('label 为空/缺省时载荷不带 label（DSH one-shot 的 label 可选）', () => {
    const session = new FakeSession([], 0);

    expect(ensureSubagentDescriptor(ctxWith(session), 'child-5', undefined)).toBe(true);
    expect(session.appended[0]?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: INTERNAL_SUBAGENT_PROVIDER,
    });
  });

  it('会话缺失 / sessions 服务缺失：静默返回 false（不得抛）', () => {
    expect(ensureSubagentDescriptor(ctxWith(undefined), 'missing', 'x')).toBe(false);
    expect(ensureSubagentDescriptor({ get: () => undefined } as unknown as Context, 'missing', 'x')).toBe(false);
  });
});
