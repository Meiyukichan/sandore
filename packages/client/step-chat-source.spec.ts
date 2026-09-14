/**
 * `step-chat-source.ts` 的单元测试：
 * - view-node 通道（`createStepChatViewSource`：ChatSnapshot 的 order/node/
 *   nodeSource/read 身份缓存、订阅通知、per-key 行级订阅粒度、未就绪回退语义）；
 * - subagent-kind 传输地址组装与装配门控（parent 未知 → 不装配且不得 open 语义）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-source.spec
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STEP_CHAT_OPEN_DIAG_GLOBAL,
  STEP_CHAT_OPEN_DIAG_LIMIT,
  applyStepChatTransport,
  buildStepChatAddress,
  buildStepChatAddressCandidates,
  catalogModeOf,
  clearStepChatOpenDiagnostics,
  createStepChatViewSource,
  lastStepChatOpenDiagnostic,
  openStepChatSessionInHost,
  readStepChatOpenDiagnostics,
  type StepChatBindingLike,
} from './step-chat-source.ts';

describe('catalogModeOf（读宿主目录条目的真实 mode）', () => {
  /** `sessions.list` 快照桩（`subagentsByParent[parent].entries[]`）。 */
  const listWith = (entries: readonly unknown[]): { getSnapshot(): unknown } => ({
    getSnapshot: () => ({ subagentsByParent: { 'host-1': { entries } } }),
  });

  it('returns the catalogued mode of a child entry (no need to guess)', () => {
    expect(catalogModeOf(
      { open: () => {}, list: listWith([{ kind: 'child', id: 'child-1', mode: 'one-shot' }]) },
      'host-1',
      'child-1',
    )).toBe('one-shot');
    expect(catalogModeOf(
      { open: () => {}, list: listWith([{ kind: 'child', id: 'child-1', mode: 'continuable' }]) },
      'host-1',
      'child-1',
    )).toBe('continuable');
  });

  it('returns undefined for missing entries / other parents / non-child rows / unknown shapes', () => {
    const sessions = { open: () => {}, list: listWith([{ kind: 'child', id: 'child-9', mode: 'one-shot' }]) };
    expect(catalogModeOf(sessions, 'host-1', 'child-1')).toBeUndefined();
    expect(catalogModeOf(sessions, 'host-2', 'child-1')).toBeUndefined();
    expect(catalogModeOf(
      { open: () => {}, list: listWith([{ kind: 'diagnostic', id: 'child-1', reason: 'corrupt' }]) },
      'host-1',
      'child-1',
    )).toBeUndefined();
    expect(catalogModeOf({ open: () => {} }, 'host-1', 'child-1')).toBeUndefined();
    expect(catalogModeOf({ open: () => {}, list: { getSnapshot: () => { throw new Error('boom') } } }, 'host-1', 'child-1'))
      .toBeUndefined();
  });

  it('puts the known mode first in the candidate order (one shot at the right mode)', () => {
    expect(buildStepChatAddressCandidates('host-1', 'child-1', 'one-shot').map(c => c.mode))
      .toEqual(['one-shot', 'continuable']);
    expect(buildStepChatAddressCandidates('host-1', 'child-1').map(c => c.mode))
      .toEqual(['continuable', 'one-shot']);
  });
});

describe('buildStepChatAddress', () => {
  it('builds the subagent-kind continuable address when the parent is known', () => {
    expect(buildStepChatAddress('host-1', 'child-1')).toEqual({
      kind: 'subagent',
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
      mode: 'continuable',
    });
  });

  it('returns undefined for unknown or empty parent (caller must not plain-open)', () => {
    expect(buildStepChatAddress(undefined, 'child-1')).toBeUndefined();
    expect(buildStepChatAddress('', 'child-1')).toBeUndefined();
  });
});

describe('applyStepChatTransport', () => {
  it('configures the session with the subagent address when the parent is known', () => {
    const configureSubagent = vi.fn();
    const ready = applyStepChatTransport({ configureSubagent }, 'host-1', 'child-1');
    expect(ready).toBe(true);
    expect(configureSubagent).toHaveBeenCalledTimes(1);
    expect(configureSubagent).toHaveBeenCalledWith(
      { kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'child-1', mode: 'continuable' },
      true,
    );
  });

  it('clears the address and reports not-ready while the parent is unknown (no plain open)', () => {
    const configureSubagent = vi.fn();
    const ready = applyStepChatTransport({ configureSubagent }, undefined, 'child-1');
    expect(ready).toBe(false);
    expect(configureSubagent).toHaveBeenCalledWith(undefined, false);
  });

  it('reports ready without configureSubagent when the runtime lacks the method (legacy plain path)', () => {
    // 老运行时无 configureSubagent：保留旧无条件 open 行为（rc.2 风格快照数据源兜底）。
    expect(applyStepChatTransport({}, 'host-1', 'child-1')).toBe(true);
  });
});

// ── 「打开与加载更早用同一个 durable 地址」（真机缺陷回归） ─────────────────────
//
// 真机缺陷：从 step 标题点进子代理会话页，最开头出现「历史加载失败：subagent Sessions
// require their durable parent address（session/agent-busy）」。根因是**打开**走普通地址
// （`sessions.open` → 宿主把 session 上的 subagent 地址清成 undefined），而**历史加载**需要
// durable 父地址 ⇒ 本组测试锁死「打开与 transport 装配在同一个函数里、用同一个 address」。

/** sessions 服务桩：记录 open/openSubagent/configureSubagent 的调用与地址。 */
function sessionsStub(options: {
  retained?: unknown
  throwOnOpen?: boolean
  /** `openSubagent` 抛错（目录里不是健康子会话 / 未进目录）。 */
  throwOnOpenSubagent?: boolean
  /** 只拒某一 mode（真机：目录条目 mode 不匹配时的 `not a healthy catalog child`）。 */
  failOnMode?: 'continuable' | 'one-shot'
  /** 自定义 `openSubagent` 行为（覆盖上面两个开关）。 */
  openSubagentHandler?: (address: { readonly mode: 'continuable' | 'one-shot' }) => void
  /** 不提供 `binding`（会话实例还没挂上：durable 地址装配无从下手）。 */
  noBinding?: boolean
  /** `sessions.list` 快照里的目录条目（`catalogModeOf` 的输入）。 */
  entries?: readonly unknown[]
} = {}) {
  const open: string[] = [];
  const openSubagent: Array<{ readonly mode: 'continuable' | 'one-shot' }> = [];
  const configured: unknown[] = [];
  const stream = {
    ...(options.entries === undefined ? {} : {
      list: { getSnapshot: () => ({ subagentsByParent: { 'host-1': { entries: options.entries } } }) },
    }),
    open: (id: string) => {
      if (options.throwOnOpen === true) throw new Error('sessions.open: unknown session');
      open.push(id);
    },
    openSubagent: (address: { readonly mode: 'continuable' | 'one-shot' }) => {
      if (options.openSubagentHandler !== undefined) {
        options.openSubagentHandler(address);
        openSubagent.push(address);
        return;
      }
      if (options.throwOnOpenSubagent === true || options.failOnMode === address.mode) {
        throw new Error('sessions.selectSubagent: not a healthy catalog child');
      }
      openSubagent.push(address);
    },
    subagentAddress: () => options.retained,
    ...(options.noBinding === true ? {} : {
      binding: () => ({
        session: { configureSubagent: (address: unknown) => { configured.push(address) } },
      }),
    }),
  };
  return { stream, open, openSubagent, configured };
}

describe('openStepChatSessionInHost：打开与历史加载装配**同一个** durable 地址', () => {
  it('opens through the durable parent address and re-applies the SAME address to the session', async () => {
    const stub = sessionsStub();
    const route = await openStepChatSessionInHost(stub.stream, {
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
    });
    const expected = buildStepChatAddress('host-1', 'child-1');
    expect(route).toBe('subagent-address');
    // ① 打开走 openSubagent + durable 地址（不是普通 open）。
    expect(stub.open).toEqual([]);
    expect(stub.openSubagent).toEqual([expected]);
    // ② 打开之后把**同一个**地址装配到 session 上 —— 这正是「加载更早」用的地址。
    expect(stub.configured).toEqual([expected]);
    expect(stub.configured[0]).toEqual(expected);
  });

  it('falls back to the retained host address when the parent is unknown', async () => {
    const retained = { kind: 'subagent', parentSessionId: 'host-9', childSessionId: 'child-1', mode: 'continuable' };
    const stub = sessionsStub({ retained });
    const route = await openStepChatSessionInHost(stub.stream, { childSessionId: 'child-1' });
    expect(route).toBe('subagent-retained');
    expect(stub.openSubagent).toEqual([retained]);
    expect(stub.configured).toEqual([retained]);
  });

  it('plain-opens as a last resort, then still applies the address when the parent is known', async () => {
    const stub = sessionsStub();
    const route = await openStepChatSessionInHost(stub.stream, {
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
    });
    // 该用例走的是地址分支（openSubagent 可用）——用「没有 openSubagent 的旧宿主」验证 plain 兜底。
    expect(route).toBe('subagent-address');
    const legacy = sessionsStub();
    const legacyStream = { ...legacy.stream, openSubagent: undefined };
    const legacyRoute = await openStepChatSessionInHost(legacyStream, {
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
    });
    expect(legacyRoute).toBe('plain');
    expect(legacy.open).toEqual(['child-1']);
    // 普通打开之后仍装配地址 ⇒ 历史加载不会退回普通地址。
    expect(legacy.configured).toEqual([buildStepChatAddress('host-1', 'child-1')]);
  });

  it('never applies a subagent address for the main-agent seat (plain session)', async () => {
    const stub = sessionsStub();
    const route = await openStepChatSessionInHost(stub.stream, {
      parentSessionId: 'host-1',
      childSessionId: 'host-1',
      variant: 'main',
    });
    expect(route).toBe('plain');
    expect(stub.open).toEqual(['host-1']);
    expect(stub.configured).toEqual([]);
  });

  it('never throws when the host refuses to open (disposed / unknown session)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = sessionsStub({ throwOnOpen: true });
    const legacyStream = { ...stub.stream, openSubagent: undefined };
    await expect(openStepChatSessionInHost(legacyStream, { childSessionId: 'child-1' })).resolves.toBeUndefined();
    // sessions 服务缺失（插件未注入）同样静默。
    expect(await openStepChatSessionInHost(undefined, { childSessionId: 'child-1' })).toBeUndefined();
    spy.mockRestore();
  });
});

// ── 打开通道诊断（真机取证：哪条通道、DSH 抛了什么） ──────────────────────────
//
// 真机缺陷现场是**静默**的：用户只看到会话页的「历史加载失败」，看不到「openSubagent 被拒了、
// 保留地址也拒了、最后走了普通 open」。本组测试锁死三条通道的失败都进诊断（并镜像到页面
// `globalThis.__sandoreStepChatOpenDiag`），供 e2e 取证 dump 直接输出。

describe('openStepChatSessionInHost 诊断（通道 + 原始错误）', () => {
  // `restoreAllMocks` 必须每例重置：本组多处 `vi.spyOn(console,'error')`，逐个 `mockRestore()`
  // 会留下嵌套 spy（前一例的调用被后一例的 spy 记到，断言计数因此串味）。
  beforeEach(() => {
    clearStepChatOpenDiagnostics();
    vi.restoreAllMocks();
  });

  it('tries BOTH address modes, then falls back to the retained one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const retained = { kind: 'subagent', parentSessionId: 'host-9', childSessionId: 'child-1', mode: 'continuable' };
    const stub = sessionsStub({ retained, throwOnOpenSubagent: true });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    // 两种 mode 都拒 → 保留地址（不同 parent）也拒 → 仅剩普通 open。
    expect(route).toBe('plain');
    const entry = lastStepChatOpenDiagnostic();
    expect(entry?.route).toBe('plain');
    expect(entry?.parentSessionId).toBe('host-1');
    // plain 兜底用「最后试过的 mode」（保留地址是 continuable ⇒ 最终装配也是 continuable）。
    expect(entry?.addressMode).toBe('continuable');
    expect(entry?.failures).toHaveLength(3);
    expect(entry?.failures[0]).toContain('openSubagent(continuable)');
    expect(entry?.failures[0]).toContain('not a healthy catalog child');
    expect(entry?.failures[1]).toContain('openSubagent(one-shot)');
    expect(entry?.failures[2]).toContain('openSubagent(retained/continuable)');
  });

  it('does not retry the retained channel when it is the same address as an already-tried candidate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const same = { kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'child-1', mode: 'continuable' };
    const stub = sessionsStub({ retained: same, throwOnOpenSubagent: true });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    expect(stub.openSubagent).toEqual([]);
    expect(lastStepChatOpenDiagnostic()?.failures[2]).toContain('skipped (same address');
  });

  it('opens an engine-created fork through the one-shot address mode (lane: 收尾/判断)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 真机：引擎裸 `agents.create` 的 fork 身份投影 mode='one-shot' → 目录条目 mode='one-shot'；
    // 硬编码 continuable 会被 `selectSubagent` 判 `not a healthy catalog child`（user 报的那条）。
    const stub = sessionsStub({ failOnMode: 'continuable' });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'fork-1' });
    expect(route).toBe('subagent-address');
    expect(stub.openSubagent).toEqual([{ kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'fork-1', mode: 'one-shot' }]);
    // 打开与「加载更早」用同一地址（同一 mode）。
    expect(stub.configured).toEqual([{ kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'fork-1', mode: 'one-shot' }]);
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
  });

  it('still applies the durable address on the plain route, and records transportApplied', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = sessionsStub();
    const legacyStream = { ...stub.stream, openSubagent: undefined };
    const route = await openStepChatSessionInHost(legacyStream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    const entry = lastStepChatOpenDiagnostic();
    expect(entry?.transportApplied).toBe(true);
    // 普通打开 + 地址装配到位 ⇒ 历史加载仍带对地址（不是真机报错的现场）。
    expect(stub.configured).toEqual([buildStepChatAddress('host-1', 'child-1')]);
    // 该路径不满足「父已知却没装地址」硬信号 → 无 console.error。
    expect(spy).not.toHaveBeenCalled();
  });

  it('flags the real-machine failure shape: parent known, every channel refused, address never applied', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 无 binding（会话实例还没挂上）+ 两种 mode 都被拒 = 历史加载必然退回普通地址报 busy。
    const stub = sessionsStub({ throwOnOpenSubagent: true, noBinding: true });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    const entry = lastStepChatOpenDiagnostic();
    expect(entry?.transportApplied).toBe(false);
    expect(entry?.failures).toHaveLength(2);
    // 硬信号：console.error 带通道/父子/失败原因（真机取证与 e2e 采集都靠它）。
    const messages = spy.mock.calls.map(call => String(call[0]));
    expect(messages.some(text => text.includes('WITHOUT a durable subagent address')
      && text.includes('parent=host-1') && text.includes('child=child-1'))).toBe(true);
  });

  it('refreshes the parent catalog BEFORE opening when the mode is unknown (no failed first attempt)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 目录冷启动现场：`refreshSubagents(parent)` 之后条目才出现 → mode 已知 → **一次命中**
    // （旧实现在信任「猜 mode」时要么白试一条候选、要么把 mode 猜错）。
    let refreshed = 0;
    let catalogReady = false;
    const open: string[] = [];
    const stub = sessionsStub({
      openSubagentHandler: (address) => {
        if (!catalogReady) throw new Error('sessions.selectSubagent: not a healthy catalog child');
        open.push(address.mode);
      },
    });
    const stream = {
      ...stub.stream,
      refreshSubagents: async (parent: string) => { refreshed += 1; catalogReady = parent === 'host-1' },
    };
    const route = await openStepChatSessionInHost(stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('subagent-address');
    expect(refreshed).toBe(1);
    expect(open).toEqual(['continuable']);
    expect(lastStepChatOpenDiagnostic()?.failures).toEqual([]);
  });

  it('still retries once after the refresh when the child is not in the refreshed catalog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 刷新后条目仍不在目录（child 未进目录 / 会话异常）→ 走「全被拒 → 兜底 + 目录重试」路径，
    // 结局如实写进诊断（不抛）。
    let refreshed = 0;
    const stub = sessionsStub({ throwOnOpenSubagent: true });
    const stream = {
      ...stub.stream,
      refreshSubagents: async () => { refreshed += 1 },
    };
    const route = await openStepChatSessionInHost(stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    expect(refreshed).toBeGreaterThanOrEqual(1); // 打开前探测至少刷了一次
    // 「全被拒 → 刷新目录后重试一次」是**异步**的（不阻塞本次打开）→ 等它落定再断言诊断。
    await vi.waitFor(() => { expect(lastStepChatOpenDiagnostic()?.catalogRetry).toBe('failed') });
    expect(refreshed).toBe(2); // 打开前 1 次 + 兜底重试前 1 次
    const entry = lastStepChatOpenDiagnostic();
    expect(entry?.failures.filter(text => text.includes('after catalog refresh'))).toHaveLength(2);
  });

  it('uses the catalogued mode straight away (engine fork = one-shot, no wrong-mode rejection)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 真机缺陷：回落普通 open 时若把 mode 猜成 continuable，历史请求会被
    // `subagent mode does not match the supplied address` 拒（引擎 fork 的目录条目是 one-shot）。
    const stub = sessionsStub({ failOnMode: 'continuable', entries: [{ kind: 'child', id: 'fork-1', mode: 'one-shot' }] });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'fork-1' });
    expect(route).toBe('subagent-address');
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBe('one-shot');
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
    expect(stub.configured).toEqual([
      { kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'fork-1', mode: 'one-shot' },
    ]);
    // 目录已给对 mode ⇒ 不必先试 continuable（零无谓被拒）。
    expect(lastStepChatOpenDiagnostic()?.failures).toEqual([]);
  });

  it('falls back with the CATALOGUED mode on the plain route (no mode mismatch on history load)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 两条 openSubagent 都被拒（目录/会话状态问题）+ 无 binding：普通 open 后仍要用**正确 mode**
    // 装配地址，否则历史加载报 `subagent mode does not match the supplied address`。
    const stub = sessionsStub({
      throwOnOpenSubagent: true,
      noBinding: true,
      entries: [{ kind: 'child', id: 'child-1', mode: 'one-shot' }],
    });
    const route = await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBe('one-shot');
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
  });

  it('falls back with the LAST-TRIED mode on the plain route (engine fork = one-shot, not continuable)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 真机缺陷（本轮 m20 复现）：目录冷 + 两条 openSubagent 都被拒 → 普通 open 时若仍按
    // `continuable` 装配，历史请求被拒：`subagent mode does not match the supplied address`。
    // 两条候选都被拒 ⇒ 用**最后试过的 mode**（此时 one-shot）装配即可对上。
    const stub = sessionsStub({ throwOnOpenSubagent: true, noBinding: false });
    const stream = { ...stub.stream };
    const route = await openStepChatSessionInHost(stream, { parentSessionId: 'host-1', childSessionId: 'fork-1' });
    expect(route).toBe('plain');
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBeUndefined();
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
    expect(stub.configured).toEqual([
      { kind: 'subagent', parentSessionId: 'host-1', childSessionId: 'fork-1', mode: 'one-shot' },
    ]);
  });

  it('awaits a catalog refresh when the mode is unknown (cold catalog) and then uses the REAL mode', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 全量 e2e 红灯根因：目录冷 → 两种候选都被拒 → 兜底「猜 mode」；猜错（门禁子代理是
    // `continuable`，被猜成 `one-shot`）时历史请求被拒：
    // `subagent mode does not match the supplied address`。
    // 修法：mode 未知时先 `await refreshSubagents(parent)`，拿到权威 mode 再组装地址。
    const modes: string[] = [];
    let refreshed = 0;
    const gateStub = sessionsStub({
      openSubagentHandler: (address) => {
        // 只有目录刷新后宿主才认（模拟「目录冷 + 条目随后出现」）。
        if (refreshed === 0) throw new Error('sessions.selectSubagent: not a healthy catalog child');
        modes.push(address.mode);
      },
    });
    const gateStream = {
      ...gateStub.stream,
      refreshSubagents: async () => {
        refreshed += 1;
        Object.assign(gateStream, {
          list: {
            getSnapshot: () => ({
              subagentsByParent: { 'host-1': { entries: [{ kind: 'child', id: 'gate-1', mode: 'continuable' }] } },
            }),
          },
        });
      },
    };
    const gateRoute = await openStepChatSessionInHost(gateStream, { parentSessionId: 'host-1', childSessionId: 'gate-1' });
    expect(gateRoute).toBe('subagent-address');
    expect(refreshed).toBe(1);
    expect(modes).toEqual(['continuable']);
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBe('continuable');
    expect(lastStepChatOpenDiagnostic()?.failures).toEqual([]);

    // 引擎 fork（one-shot）同样走「刷新 → 权威 mode → 一次命中」。
    clearStepChatOpenDiagnostics();
    let refreshedFork = 0;
    const forkStub = sessionsStub({
      openSubagentHandler: (address) => {
        if (refreshedFork === 0) throw new Error('sessions.selectSubagent: not a healthy catalog child');
        expect(address.mode).toBe('one-shot');
      },
    });
    const forkStream = {
      ...forkStub.stream,
      refreshSubagents: async () => {
        refreshedFork += 1;
        Object.assign(forkStream, {
          list: {
            getSnapshot: () => ({
              subagentsByParent: { 'host-1': { entries: [{ kind: 'child', id: 'fork-1', mode: 'one-shot' }] } },
            }),
          },
        });
      },
    };
    const forkRoute = await openStepChatSessionInHost(forkStream, { parentSessionId: 'host-1', childSessionId: 'fork-1' });
    expect(forkRoute).toBe('subagent-address');
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBe('one-shot');
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
  });

  it('keeps going when the catalog refresh fails (no throw; falls back to the last tried mode)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = sessionsStub({ throwOnOpenSubagent: true });
    const stream = { ...stub.stream, refreshSubagents: async () => { throw new Error('remote down') } };
    const route = await openStepChatSessionInHost(stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    expect(route).toBe('plain');
    expect(lastStepChatOpenDiagnostic()?.catalogMode).toBeUndefined();
    // 未知 mode 时的兜底：用「最后试过的那条候选」（两条都失败 ⇒ one-shot）。
    expect(lastStepChatOpenDiagnostic()?.addressMode).toBe('one-shot');
  });

  it('mirrors the diagnostics onto the page global for e2e dumps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = sessionsStub();
    await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: 'child-1' });
    const mirrored = (globalThis as Record<string, unknown>)[STEP_CHAT_OPEN_DIAG_GLOBAL] as {
      last?: { readonly route?: string; readonly childSessionId?: string }
      entries?: readonly unknown[]
    } | undefined;
    expect(mirrored?.last?.route).toBe('subagent-address');
    expect(mirrored?.last?.childSessionId).toBe('child-1');
    expect(readStepChatOpenDiagnostics()).toHaveLength(1);
    // 环形缓冲有界（长会话不增长）。
    for (let index = 0; index < STEP_CHAT_OPEN_DIAG_LIMIT + 5; index += 1) {
      await openStepChatSessionInHost(stub.stream, { parentSessionId: 'host-1', childSessionId: `child-${String(index)}` });
    }
    expect(readStepChatOpenDiagnostics()).toHaveLength(STEP_CHAT_OPEN_DIAG_LIMIT);
  });
});

// ── view-node 通道（rc.1 ChatSnapshot 的 order/nodes/… 读取面） ─────────────

/** 引擎 ChatSnapshot.nodes（ChatNodeStore）的 fake：per-key 源 + 手动 notify。 */
class FakeChatNodeStore {
  private readonly byKey = new Map<string, unknown>();
  // 引擎语义：per-key 源对象按 key 缓存（同一 store 实例跨调用身份稳定）。
  private readonly keyed = new Map<string, {
    listeners: Set<() => void>
    source: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
  }>();

  get(key: string): unknown {
    return this.byKey.get(key);
  }

  source(key: string) {
    let entry = this.keyed.get(key);
    if (entry === undefined) {
      const listeners = new Set<() => void>();
      entry = {
        listeners,
        source: {
          getSnapshot: () => this.byKey.get(key),
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener) };
          },
        },
      };
      this.keyed.set(key, entry);
    }
    return entry.source;
  }

  /** 换入某 key 的新节点（upsert 语义：新对象身份触发 per-key 发布）。 */
  set(key: string, raw: unknown): void {
    this.byKey.set(key, raw);
  }

  /** 只通知该 key 的行级订阅者（引擎 store.publish 的 dirty-key 语义）。 */
  notify(key: string): void {
    for (const listener of [...(this.keyed.get(key)?.listeners ?? [])]) listener();
  }
}

/** fake uiConversation target('chat')：外层订阅 + 手动发布。 */
function fakeChatTarget() {
  const listeners = new Set<() => void>();
  let snapshot: unknown;
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener) };
    },
    publish: (next: unknown) => {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

type FakeTarget = ReturnType<typeof fakeChatTarget>;

/** 组一条经 uiConversation 解析到 target 的 binding。 */
function bindingTo(target: FakeTarget): StepChatBindingLike {
  return {
    session: { subscribe: vi.fn(() => () => {}), getSnapshot: () => ({}) },
    ctx: {
      get: (name: string) => (name === 'uiConversation'
        ? { binding: () => ({ target: () => target }) }
        : undefined),
    },
  } as unknown as StepChatBindingLike;
}

/** 引擎 ChatNode 形状的 raw 节点。 */
function rawNode(key: string, kind: string, anchorSeq: number, over: object = {}): object {
  return {
    key,
    kind,
    target: 'chat',
    id: key,
    anchorSeq,
    data: { kind, seq: anchorSeq },
    location: { kind: 'turn', turn: { turn: 1, status: 'open', data: {} } },
    visibility: 'visible',
    ...over,
  };
}

describe('createStepChatViewSource（view-node 通道）', () => {
  it('reads the ChatSnapshot face with stable read/node identities', () => {
    const store = new FakeChatNodeStore();
    const a = rawNode('a', 'user', 1);
    const b = rawNode('b', 'assistant-step', 2, { data: { kind: 'assistant-step', blocks: [] } });
    store.set('a', a);
    store.set('b', b);
    const target = fakeChatTarget();
    target.publish({ order: ['a', 'b'], nodes: store });

    const feed = createStepChatViewSource(bindingTo(target));
    expect(feed).toBeDefined();
    expect(feed!.read()).toEqual({ ok: true, order: ['a', 'b'] });
    // 发布之间 read 值身份稳定（uSES 快照侧）。
    expect(feed!.read()).toBe(feed!.read());
    // node(key) → 本地 view-node；同一底层节点身份稳定。
    expect(feed!.node('a')).toEqual({
      key: 'a',
      kind: 'user',
      data: a.data,
      anchorSeq: 1,
      location: { kind: 'turn', turn: 1 },
    });
    expect(feed!.node('a')).toBe(feed!.node('a'));
    expect(feed!.node('missing')).toBeUndefined();
    expect(feed!.nodesSnapshot().map(node => node.key)).toEqual(['a', 'b']);
  });

  it('publishes: read identity and node views follow the latest snapshot', () => {
    const store = new FakeChatNodeStore();
    store.set('a', rawNode('a', 'user', 1));
    store.set('b', rawNode('b', 'user', 2));
    const target = fakeChatTarget();
    target.publish({ order: ['a', 'b'], nodes: store });
    const feed = createStepChatViewSource(bindingTo(target))!;

    const listener = vi.fn();
    const unsubscribe = feed.subscribe(listener);
    const readBefore = feed.read();
    const nodeBefore = feed.node('a');

    // 引擎发布（顺序变化：b 移出窗口，a 换新节点对象）。
    store.set('a', rawNode('a', 'user', 5));
    target.publish({ order: ['a'], nodes: store });

    expect(listener).toHaveBeenCalledTimes(1);
    const readAfter = feed.read();
    expect(readAfter).not.toBe(readBefore);
    expect(readAfter.order).toEqual(['a']);
    expect(readAfter.order).not.toBe(readBefore.order);
    expect(feed.node('a')).not.toBe(nodeBefore);
    expect(feed.node('a')?.anchorSeq).toBe(5);
    // 行集以 order 为权威（节点可能以 hidden 留在 store 内，行不渲染）。
    expect(feed.nodesSnapshot().map(node => node.key)).toEqual(['a']);
    // 再次 read 回到身份缓存。
    expect(feed.read()).toBe(feed.read());
    unsubscribe();
    target.publish({ order: ['a'], nodes: store });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes per-key sources that notify only for their own key (row granularity)', () => {
    const store = new FakeChatNodeStore();
    store.set('a', rawNode('a', 'user', 1));
    store.set('b', rawNode('b', 'assistant-step', 2, { data: { blocks: [] } }));
    const target = fakeChatTarget();
    target.publish({ order: ['a', 'b'], nodes: store });
    const feed = createStepChatViewSource(bindingTo(target))!;

    const sourceA = feed.nodeSource('a')!;
    const sourceB = feed.nodeSource('b')!;
    expect(sourceA).toBeDefined();
    // 包装源身份稳定（引擎 per-key 源由 store 缓存）。
    expect(feed.nodeSource('a')).toBe(sourceA);
    expect(sourceA.getSnapshot()?.key).toBe('a');

    const seenA = vi.fn();
    const seenB = vi.fn();
    sourceA.subscribe(seenA);
    sourceB.subscribe(seenB);

    // 外层发布（无 key 内容变化）不触发行级订阅（ChatView 行级粒度：行内容只随
    // 自身 dirty-key 发布更新）。
    target.publish({ order: ['a', 'b'], nodes: store });
    expect(seenA).not.toHaveBeenCalled();
    expect(seenB).not.toHaveBeenCalled();
    // key b 的 dirty 发布只通知 b 行。
    store.notify('b');
    expect(seenB).toHaveBeenCalledTimes(1);
    expect(seenA).not.toHaveBeenCalled();
    // 通知后 nodeSource.getSnapshot 读到新节点（与 store 同步）。
    const nextB = rawNode('b', 'assistant-step', 3, { data: { blocks: [{ kind: 'text', text: 'x' }] } });
    store.set('b', nextB);
    store.notify('b');
    expect(seenB).toHaveBeenCalledTimes(2);
    expect(sourceB.getSnapshot()?.anchorSeq).toBe(3);
  });

  it('exposes timeline/navigation/processOf leaves when the snapshot carries them', () => {
    const store = new FakeChatNodeStore();
    store.set('a', rawNode('a', 'user', 1));
    const timeline = { turnOrder: [1], turns: new Map([[1, { turn: 1, status: 'open' }]]) };
    const navigation = { items: () => [{ turn: 1, anchorKey: 'a', prompt: '', response: '' }] };
    const target = fakeChatTarget();
    target.publish({ order: ['a'], nodes: store, timeline, navigation });
    const feed = createStepChatViewSource(bindingTo(target))!;
    expect(feed.timeline()).toBe(timeline);
    expect(feed.navigationItems()).toEqual([{ turn: 1, anchorKey: 'a', prompt: '', response: '' }]);
    // fake store 未提供 processSource → processOf 缺席（undefined）。
    expect(feed.processOf('a')).toBeUndefined();
  });

  it('keeps a not-ready feed (ok=false) until the ChatSnapshot shape appears', () => {
    const target = fakeChatTarget();
    const feed = createStepChatViewSource(bindingTo(target));
    // target 接口存在但快照未就绪：feed 存在（订阅挂住等待就绪），read 为 ok=false。
    expect(feed).toBeDefined();
    const before = feed!.read();
    expect(before).toEqual({ ok: false, order: [] });
    expect(feed!.read()).toBe(before);
    expect(feed!.node('a')).toBeUndefined();
    expect(feed!.nodeSource('a')).toBeUndefined();
    expect(feed!.timeline()).toBeUndefined();
    expect(feed!.navigationItems()).toEqual([]);
    // legacy-only 形状不算 ChatSnapshot（维持 ok=false）。
    target.publish({ legacy: { nodes: [{ kind: 'user' }] } });
    expect(feed!.read().ok).toBe(false);
    // 真 ChatSnapshot 出现 → 同一 feed 自动翻转（无需重建订阅）。
    const store = new FakeChatNodeStore();
    store.set('a', rawNode('a', 'user', 1));
    target.publish({ order: ['a'], nodes: store });
    expect(feed!.read()).toEqual({ ok: true, order: ['a'] });
  });

  it('returns undefined without the uiConversation target', () => {
    const binding = {
      session: { subscribe: vi.fn(() => () => {}), getSnapshot: () => ({}) },
      ctx: { get: () => undefined },
    } as unknown as StepChatBindingLike;
    expect(createStepChatViewSource(binding)).toBeUndefined();
    expect(createStepChatViewSource(undefined)).toBeUndefined();
  });
});

