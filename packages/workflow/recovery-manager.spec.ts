/**
 * recovery-manager.ts（RecoveryManager）的单元测试：重试三模式（continue/revert/fork）、
 * 前置校验、状态清理与历史记录、step-retried 事件、崩溃恢复 Step 分类。
 * @module @meiyukichan/dsh-sandore/workflow/src/recovery-manager.spec
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import type { Agent, CreateAgentOptions } from '../microflow/subagents';
import { SandoreError } from './errors.ts';
import { computeSafeRevertBoundary, hasUnclosedTurnTail, listClosedTurnBoundaries, RecoveryManager, synthesizeChildId } from './recovery-manager.ts';
import type { ForkSourceSession, RevertBoundaryOption, RetryMode } from './recovery-manager.ts';
import type { WorkflowTaskState } from './schema.ts';

type ExecutedStep = WorkflowTaskState['executedSteps'][number];

/** 构造一条 `turn/start` 事件（安全边界计算的 turn 边界标记）。 */
function turnStartEvent(seq: number, turn = 0): DshSessionEvent {
  return { type: 'turn/start', seq, time: 0, data: { turn } };
}

/** 构造一条 `turn/end` 事件（闭合 turn 结束标记）。 */
function turnEndEvent(seq: number, turn = 0): DshSessionEvent {
  return { type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } };
}

/** 构造一条 `assistant/message` 事件（含 text 块，供 listClosedTurnBoundaries 提取预览）。 */
function assistantMessageEvent(seq: number, text: string, turn = 0): DshSessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn, step: 0, message: { content: [{ type: 'text', text }], source: { provider: 'mock', model: 'mock' } } },
  };
}

/** 构造一个 failed 的 agent 子代理 Step。 */
function makeFailedStep(overrides: Partial<ExecutedStep> = {}): ExecutedStep {
  return {
    id: 'exec-1',
    stepId: 'step-1',
    stageId: 'stg-1',
    name: 'step-1',
    status: 'failed',
    command: { type: 'agent', value: { promptText: 'do work' } },
    sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
    visitCount: 1,
    error: 'boom',
    ...overrides,
  };
}

/** 构造一个含指定 Step 的实例状态快照。 */
function makeState(step: ExecutedStep, status: WorkflowTaskState['status'] = 'failed'): WorkflowTaskState {
  const createdAt = '2026-08-16T00:00:00.000Z';
  return {
    taskId: 'task-1',
    workflowId: 'wfl-1',
    cwd: '/tmp',
    status,
    originalInput: 'input',
    currentStageId: 'stg-1',
    executedSteps: [step],
    stageInfos: [{ id: 'stg-1', name: 'stage', status: status === 'failed' ? 'failed' : 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 构造一个含多个 Step 的实例状态快照（首个 Step 用于继承 makeState 的默认形状）。 */
function makeMultiState(steps: ExecutedStep[], status: WorkflowTaskState['status'] = 'running'): WorkflowTaskState {
  return { ...makeState(steps[0]!, status), executedSteps: steps };
}

/** 构造最小 host/child Agent 桩。 */
function makeAgent(id: string): Agent {
  return {
    id,
    options: {},
    session: { events: [] },
    inbox: { hasPending: false },
    status: 'idle',
    ctx: undefined,
    followup: () => {},
    whenIdle: async () => {},
  };
}

/** 定位重试追加的新执行段（attemptIndex 最大的段；旧 failed 段 attemptIndex 0 保留）。 */
function newSegmentOf(state: WorkflowTaskState): ExecutedStep | undefined {
  const segments = state.executedSteps.filter(step => (step.attemptIndex ?? 0) > 0);
  if (segments.length === 0) {
    return undefined;
  }
  return segments.sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
}

/** 测试 harness：注入 fakes 并暴露可断言的回调记录。 */
function makeHarness(options?: {
  step?: ExecutedStep;
  status?: WorkflowTaskState['status'];
  sessions?: Map<string, ForkSourceSession>;
  forked?: ForkSourceSession;
  onResume?: (state: WorkflowTaskState) => void;
  /** 若为 true，forkSession 在 boundary 省略且源会话尾部未闭合时模拟 DSH OPEN_TURN 抛错。 */
  enforceOpenTurn?: boolean;
  /** F1 dispose 语义：live 子代理 id 集合（注入 getAgent；缺省 undefined = 不注入、放行）。 */
  liveAgents?: Set<string>;
}) {
  let state = makeState(options?.step ?? makeFailedStep(), options?.status ?? 'failed');
  const followups: Array<{ childId: string; content: ContentBlock[] }> = [];
  const creates: CreateAgentOptions[] = [];
  const forks: Array<{ source: string; boundary: number | undefined }> = [];
  const retried: Array<{ stepId: string; mode: RetryMode; name: string; loopIteration?: number[] }> = [];
  let resumeCount = 0;
  const sessions = options?.sessions ?? new Map<string, ForkSourceSession>();
  let forked = options?.forked ?? { events: [] as readonly DshSessionEvent[] };
  const enforceOpenTurn = options?.enforceOpenTurn ?? false;
  const signal = new AbortController().signal;

  const manager = new RecoveryManager({
    signal,
    readState: () => state,
    commitState: (next) => {
      state = next;
    },
    followup: async (childId, content) => {
      followups.push({ childId, content });
    },
    createAgent: async (createOptions) => {
      creates.push(createOptions);
      return { agent: makeAgent(createOptions.sessionId), dispose: async () => {} };
    },
    getSession: (id) => sessions.get(id),
    // F1：注入 getAgent（live 判定）时 retryStep 先 fail-fast 已 dispose 的目标会话。
    getAgent: options?.liveAgents === undefined
      ? undefined
      : (childId) => (options.liveAgents!.has(childId) ? makeAgent(childId) : undefined),
    forkSession: (source, boundary) => {
      // 模拟 DSH sessions.fork 的 OPEN_TURN 校验：boundary 省略（= 末事件 seq）
      // 且末事件落在未闭合 turn 内时抛 OPEN_TURN；defense 应保证 boundary 被显式传入。
      if (enforceOpenTurn && boundary === undefined) {
        const sourceSession = sessions.get(source);
        if (sourceSession !== undefined && hasUnclosedTurnTail(sourceSession.events)) {
          throw new SandoreError(
            `fork boundary for session "${source}" ends inside open turn`,
            'OPEN_TURN',
          );
        }
      }
      forks.push({ source, boundary });
      return forked;
    },
    emitStepRetried: (stepId, mode, name, loopIteration) => {
      retried.push({ stepId, mode, name, ...(loopIteration === undefined ? {} : { loopIteration }) });
    },
    resumeExecution: async () => {
      resumeCount += 1;
      options?.onResume?.(state);
    },
  });

  return {
    manager,
    getState: () => state,
    setState: (next: WorkflowTaskState) => {
      state = next;
    },
    followups,
    creates,
    forks,
    retried,
    getResumeCount: () => resumeCount,
    sessions,
    setForked: (events: readonly DshSessionEvent[]) => {
      forked = { events };
    },
  };
}

describe('retryStep dispose fail-fast（F1：rc.1 对已结算子代理 dispose 的语义）', () => {
  it('refuses to retry when the target subagent was disposed: no new segment, no retry event, no followup', async () => {
    const { manager, getState, followups, retried } = makeHarness({ liveAgents: new Set() });
    await expect(manager.retryStep('step-1', 'continue', 'again'))
      .rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    expect(retried).toHaveLength(0);
    expect(followups).toHaveLength(0);
    // 无新段：executedSteps 仍只有原 failed 段（attemptIndex 0）。
    expect(getState().executedSteps).toHaveLength(1);
    expect(getState().executedSteps[0]?.status).toBe('failed');
  });

  it('proceeds when the injected live check hits (session still live)', async () => {
    const { manager, followups, retried } = makeHarness({ liveAgents: new Set(['child-1']) });
    await expect(manager.retryStep('step-1', 'continue', 'again')).resolves.toBeUndefined();
    expect(followups).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
});

describe('computeSafeRevertBoundary', () => {
  it('returns the seq of the last closed turn', () => {
    const events = [turnStartEvent(0), turnEndEvent(3), turnStartEvent(4), turnEndEvent(7)];
    expect(computeSafeRevertBoundary(events)).toBe(7);
  });

  it('returns undefined when there is no closed turn (open turn)', () => {
    expect(computeSafeRevertBoundary([turnStartEvent(0)])).toBeUndefined();
    expect(computeSafeRevertBoundary([])).toBeUndefined();
  });
});

describe('hasUnclosedTurnTail', () => {
  it('returns true when the tail event is inside an open turn (turn/start with no matching turn/end)', () => {
    expect(hasUnclosedTurnTail([turnStartEvent(0), assistantMessageEvent(1, 'hi')])).toBe(true);
    // 前面有闭合 turn，尾部仍有未闭合 turn。
    expect(hasUnclosedTurnTail([turnStartEvent(0), turnEndEvent(1), turnStartEvent(2), assistantMessageEvent(3, 'hi')])).toBe(true);
  });

  it('returns false when the tail is at or after a closed turn/end (no open turn)', () => {
    expect(hasUnclosedTurnTail([turnStartEvent(0), turnEndEvent(1)])).toBe(false);
    expect(hasUnclosedTurnTail([turnStartEvent(0), turnEndEvent(1), turnStartEvent(2), turnEndEvent(3)])).toBe(false);
    expect(hasUnclosedTurnTail([])).toBe(false);
    expect(hasUnclosedTurnTail([assistantMessageEvent(0, 'hi')])).toBe(false);
  });
});

describe('listClosedTurnBoundaries', () => {
  it('returns one option per closed turn with seq/turn/preview', () => {
    const events = [
      turnStartEvent(0, 0),
      assistantMessageEvent(1, 'first answer', 0),
      turnEndEvent(2, 0),
      turnStartEvent(3, 1),
      assistantMessageEvent(4, 'second answer', 1),
      turnEndEvent(5, 1),
    ];
    const options = listClosedTurnBoundaries(events);
    expect(options).toEqual<RevertBoundaryOption[]>([
      { seq: 2, turn: 0, preview: 'first answer' },
      { seq: 5, turn: 1, preview: 'second answer' },
    ]);
  });

  it('truncates preview to 80 chars', () => {
    const long = 'x'.repeat(120);
    const events = [turnStartEvent(0, 0), assistantMessageEvent(1, long, 0), turnEndEvent(2, 0)];
    const options = listClosedTurnBoundaries(events);
    expect(options[0]?.preview).toBe(`${'x'.repeat(80)}…`);
  });

  it('skips the unclosed tail turn (turn/start with no turn/end)', () => {
    const events = [
      turnStartEvent(0, 0),
      turnEndEvent(1, 0),
      turnStartEvent(2, 1),
      assistantMessageEvent(3, 'unmatched', 1),
    ];
    const options = listClosedTurnBoundaries(events);
    expect(options).toEqual<RevertBoundaryOption[]>([{ seq: 1, turn: 0, preview: '' }]);
  });

  it('concatenates multiple assistant messages within one turn', () => {
    const events = [
      turnStartEvent(0, 0),
      assistantMessageEvent(1, 'part one', 0),
      assistantMessageEvent(2, 'part two', 0),
      turnEndEvent(3, 0),
    ];
    const options = listClosedTurnBoundaries(events);
    expect(options[0]?.preview).toBe('part one\npart two');
  });
});

describe('RecoveryManager.retryStep validation', () => {
  it('throws INVALID_OPERATION for a running step with no side effects', async () => {
    const harness = makeHarness({ step: makeFailedStep({ status: 'running' }), status: 'running' });
    await expect(harness.manager.retryStep('step-1', 'continue', 'msg')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    expect(harness.followups).toHaveLength(0);
    expect(harness.retried).toHaveLength(0);
  });

  it('throws INVALID_OPERATION for an interacting and paused step', async () => {
    for (const status of ['interacting', 'paused'] as const) {
      const harness = makeHarness({ step: makeFailedStep({ status }), status: status === 'paused' ? 'paused' : 'interacting' });
      await expect(harness.manager.retryStep('step-1', 'continue', 'msg')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    }
  });

  it('throws INVALID_OPERATION for a failed non-subagent (shell) step with no side effects', async () => {
    const type = 'shell' as const;
    const step = makeFailedStep({
      command: { type, value: { command: 'echo hi' } } as ExecutedStep['command'],
      sessionMeta: { childId: `step-1-${type}`, synthetic: true, command: type },
    });
    const harness = makeHarness({ step, status: 'failed' });
    await expect(harness.manager.retryStep('step-1', 'continue', 'msg')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    // 无虚假副作用：不 followup、不发 step-retried、不追加 retryHistory、实例保持 failed。
    expect(harness.followups).toHaveLength(0);
    expect(harness.retried).toHaveLength(0);
    expect(harness.getState().executedSteps[0]?.retryHistory).toBeUndefined();
    expect(harness.getState().status).toBe('failed');
  });

  it('retries a failed prompt step with continue mode (决策 D3: prompt 为真实子代理，可重试)', async () => {
    const harness = makeHarness({
      step: makeFailedStep({
        command: { type: 'prompt', value: { promptText: 'do it' } } as ExecutedStep['command'],
        sessionMeta: { childId: 'child-1', synthetic: false, command: 'prompt' },
      }),
    });
    await harness.manager.retryStep('step-1', 'continue', 'please retry');

    // prompt 与 agent/skill/mcp 同走子代理续跑：followup 原 childId + retryHistory 记录。
    expect(harness.followups).toHaveLength(1);
    expect(harness.followups[0]?.childId).toBe('child-1');
    expect(harness.retried).toEqual([{ stepId: 'step-1', mode: 'continue', name: 'step-1' }]);
    const step = newSegmentOf(harness.getState());
    expect(step?.sessionMeta?.childId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('continue');
    expect(step?.retryHistory?.[0]?.userMessage).toBe('please retry');
  });

  it('returns a structured no-op for a completed instance', async () => {
    const harness = makeHarness({ status: 'completed' });
    await harness.manager.retryStep('step-1', 'continue', 'msg');
    expect(harness.followups).toHaveLength(0);
    expect(harness.retried).toHaveLength(0);
    expect(harness.getState().status).toBe('completed');
  });

  it('returns a structured no-op for a completed step (instance not terminal)', async () => {
    const harness = makeHarness({ step: makeFailedStep({ status: 'completed' }), status: 'running' });
    await harness.manager.retryStep('step-1', 'continue', 'msg');
    expect(harness.followups).toHaveLength(0);
    expect(harness.retried).toHaveLength(0);
  });

  it('throws INVALID_OPERATION for an unknown step', async () => {
    const harness = makeHarness();
    await expect(harness.manager.retryStep('step-missing', 'continue', 'msg')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('RecoveryManager.retryStep continue mode', () => {
  it('follows up the original childId and records { mode: continue } with unchanged sessionMeta', async () => {
    const harness = makeHarness();
    await harness.manager.retryStep('step-1', 'continue', 'please retry');

    expect(harness.followups).toHaveLength(1);
    expect(harness.followups[0]?.childId).toBe('child-1');
    expect(harness.followups[0]?.content).toEqual([{ type: 'text', text: 'please retry' }]);
    expect(harness.retried).toEqual([{ stepId: 'step-1', mode: 'continue', name: 'step-1' }]);

    // 段模型：旧 failed 段保留定格快照，重试新段（attemptIndex 1）承载 retryHistory。
    const step = newSegmentOf(harness.getState());
    expect(step?.sessionMeta?.childId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('continue');
    expect(step?.retryHistory?.[0]?.userMessage).toBe('please retry');
    expect(step?.parentSessionId).toBeUndefined();
    // 新语义：retryStep **不写 state.userMessages**（指令已在子代理会话里、重试记在段内 retryHistory）。
    expect(harness.getState().userMessages ?? []).toEqual([]);
    expect(harness.getResumeCount()).toBe(1);
  });

  it('passes step name and loopIteration through to emitStepRetried', async () => {
    const harness = makeHarness({ step: makeFailedStep({ loopIteration: [2, 1] }) });
    await harness.manager.retryStep('step-1', 'continue', 'please retry');

    expect(harness.retried).toEqual([{ stepId: 'step-1', mode: 'continue', name: 'step-1', loopIteration: [2, 1] }]);
  });
});

describe('RecoveryManager.retryStep revert mode', () => {
  it('forks at the safe boundary, creates a new seeded agent, and records parentSessionId', async () => {
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', { events: [turnStartEvent(0), turnEndEvent(3)] });
    const forked = { events: [turnStartEvent(0), turnEndEvent(3)] };
    const harness = makeHarness({ sessions, forked });

    await harness.manager.retryStep('step-1', 'revert', 'rollback');

    expect(harness.forks).toEqual([{ source: 'child-1', boundary: 3 }]);
    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0]?.seed).toEqual(forked.events);
    // 上游适配：meta 删 seedLength 改 isSeeded，前缀长度移到顶层 inheritedEventCount。
    expect(harness.creates[0]?.meta).toMatchObject({ origin: 'subagent', parentSession: 'child-1', isSeeded: true });
    expect(harness.creates[0]?.inheritedEventCount).toBe(2);

    const newChildId = harness.creates[0]?.sessionId;
    expect(newChildId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // 子代理列表标题：`retry <Step 名称> · <childId>`（名称缺失时回退 step id —— 本用例的
    // fixture 段无 `name`，故呈现为 `retry step-1 · <uuid>`）；引擎消费该字段补写身份事件，
    // 与 step 执行/门禁/收尾/判断四类同款形态（见 workflow/subagent-identity.ts）。
    expect((harness.creates[0] as { descriptorLabel?: string })?.descriptorLabel)
      .toBe(`retry step-1 · ${String(newChildId)}`);
    const step = newSegmentOf(harness.getState());
    expect(step?.sessionMeta?.childId).toBe(newChildId);
    expect(step?.sessionMeta?.synthetic).toBe(false);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(harness.followups[0]?.childId).toBe(newChildId);
  });

  it('ends with an error and keeps the instance failed when no closed turn boundary exists', async () => {
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', { events: [turnStartEvent(0)] });
    const harness = makeHarness({ sessions });

    await expect(harness.manager.retryStep('step-1', 'revert', 'rollback')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    const state = harness.getState();
    expect(state.status).toBe('failed');
    const step = newSegmentOf(state);
    expect(step?.status).toBe('failed');
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(step?.retryHistory?.[0]?.result).toBe('failed');
    expect(harness.creates).toHaveLength(0);
  });

  it('reverts to the user-supplied earlier turn/end boundary (not the last closed turn)', async () => {
    // 源会话含两个闭合 turn（seq 2 与 5）；用户传 revertBoundary=2 选更早 turn。
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', {
      events: [
        turnStartEvent(0, 0), assistantMessageEvent(1, 'first', 0), turnEndEvent(2, 0),
        turnStartEvent(3, 1), assistantMessageEvent(4, 'second', 1), turnEndEvent(5, 1),
      ],
    });
    const forked = { events: [turnStartEvent(0, 0), assistantMessageEvent(1, 'first', 0), turnEndEvent(2, 0)] };
    const harness = makeHarness({ sessions, forked });

    await harness.manager.retryStep('step-1', 'revert', 'rollback', 2);

    // 用户传入的更早 boundary（seq 2）直接透传给 forkSession，而非默认的最后一个闭合 turn（seq 5）。
    expect(harness.forks).toEqual([{ source: 'child-1', boundary: 2 }]);
    expect(harness.creates[0]?.seed).toEqual(forked.events);
    // 上游适配：isSeeded + 顶层 inheritedEventCount（= 3 条事件的闭合 turn 前缀）。
    expect(harness.creates[0]?.meta?.isSeeded).toBe(true);
    expect(harness.creates[0]?.inheritedEventCount).toBe(3);
    const step = newSegmentOf(harness.getState());
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(harness.followups[0]?.childId).toBe(harness.creates[0]?.sessionId);
  });

  it('falls back to the last closed turn when revertBoundary is omitted (default behavior unchanged)', async () => {
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', {
      events: [
        turnStartEvent(0, 0), turnEndEvent(2, 0),
        turnStartEvent(3, 1), turnEndEvent(5, 1),
      ],
    });
    const harness = makeHarness({ sessions });

    await harness.manager.retryStep('step-1', 'revert', 'rollback');

    // 未传 revertBoundary → computeSafeRevertBoundary = 最后一个闭合 turn/end seq（5）。
    expect(harness.forks).toEqual([{ source: 'child-1', boundary: 5 }]);
  });
});

describe('RecoveryManager.retryStep fork mode', () => {
  it('forks with no boundary (full history), creates a new agent, and records { mode: fork }', async () => {
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', { events: [turnStartEvent(0), turnEndEvent(3)] });
    const forked = { events: [turnStartEvent(0), turnEndEvent(3)] };
    const harness = makeHarness({ sessions, forked });

    await harness.manager.retryStep('step-1', 'fork', 'fork it');

    expect(harness.forks).toEqual([{ source: 'child-1', boundary: undefined }]);
    expect(harness.creates[0]?.seed).toEqual(forked.events);
    const newChildId = harness.creates[0]?.sessionId;
    const step = newSegmentOf(harness.getState());
    expect(step?.sessionMeta?.childId).toBe(newChildId);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
  });

  it('auto-reverts to the last closed turn/end when the source session has an unclosed tail (OPEN_TURN defense)', async () => {
    // 源会话：turn 0 闭合（seq 2），turn 1 未闭合（turn/start seq 3 + assistant seq 4，无 turn/end）。
    // fork(undefined) 在此会确定性抛 OPEN_TURN（末事件 4 落在未闭合 turn 1 内）。
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', {
      events: [
        turnStartEvent(0, 0), assistantMessageEvent(1, 'first', 0), turnEndEvent(2, 0),
        turnStartEvent(3, 1), assistantMessageEvent(4, 'unmatched', 1),
      ],
    });
    const forked = { events: [turnStartEvent(0, 0), assistantMessageEvent(1, 'first', 0), turnEndEvent(2, 0)] };
    // enforceOpenTurn=true：模拟 DSH fork(undefined) 在未闭合尾部下抛 OPEN_TURN。
    // defense 必须先算出 boundary（=2）再调 forkSession，从而避开 OPEN_TURN。
    const harness = makeHarness({ sessions, forked, enforceOpenTurn: true });

    await harness.manager.retryStep('step-1', 'fork', 'fork it');

    // boundary 被显式设为最后一个闭合 turn/end seq（2），不是 undefined（全量历史）。
    expect(harness.forks).toEqual([{ source: 'child-1', boundary: 2 }]);
    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0]?.seed).toEqual(forked.events);
    const step = newSegmentOf(harness.getState());
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.parentSessionId).toBe('child-1');
    // followup 到新 childId 续跑，未抛 OPEN_TURN。
    expect(harness.followups[0]?.childId).toBe(harness.creates[0]?.sessionId);
  });

  it('throws INVALID_OPERATION when forking a source with an unclosed tail and no prior closed turn', async () => {
    // 源会话只有未闭合 turn（turn/start seq 0 + assistant seq 1，无任何 turn/end）。
    const sessions = new Map<string, ForkSourceSession>();
    sessions.set('child-1', { events: [turnStartEvent(0, 0), assistantMessageEvent(1, 'hi', 0)] });
    const harness = makeHarness({ sessions, enforceOpenTurn: true });

    await expect(harness.manager.retryStep('step-1', 'fork', 'fork it')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    // 检测到未闭合尾部但 computeSafeRevertBoundary 无闭合 turn 可回退 → 抛错、不 fork、实例 failed。
    expect(harness.forks).toHaveLength(0);
    expect(harness.creates).toHaveLength(0);
    const state = harness.getState();
    expect(state.status).toBe('failed');
    const step = newSegmentOf(state);
    expect(step?.status).toBe('failed');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.retryHistory?.[0]?.result).toBe('failed');
  });
});

describe('RecoveryManager.retryStep history result', () => {
  it('updates the last retryHistory record to completed when the resumed step completes', async () => {
    const harness = makeHarness({
      onResume: (state) => {
        const step = newSegmentOf(state);
        if (step !== undefined) {
          step.status = 'completed';
        }
      },
    });
    await harness.manager.retryStep('step-1', 'continue', 'msg');
    expect(newSegmentOf(harness.getState())?.retryHistory?.[0]?.result).toBe('completed');
  });

  it('updates the last retryHistory record to failed when the resumed step fails', async () => {
    const harness = makeHarness();
    await harness.manager.retryStep('step-1', 'continue', 'msg');
    // resumeExecution 未将 Step 置 completed，故 result 判为 failed。
    expect(newSegmentOf(harness.getState())?.retryHistory?.[0]?.result).toBe('failed');
  });
});

describe('RecoveryManager.recover', () => {
  it('follows up running/interacting subagent steps and returns hasResume', async () => {
    const harness = makeHarness({ step: makeFailedStep({ status: 'running' }), status: 'running' });
    const result = await harness.manager.recover();
    expect(result).toEqual({ hasResume: true, hasFailure: false });
    expect(harness.followups).toHaveLength(1);
    expect(harness.followups[0]?.childId).toBe('child-1');
  });

  it('marks a synthetic (shell) running step as failed and returns hasFailure', async () => {
    const step = makeFailedStep({
      status: 'running',
      command: { type: 'shell', value: { command: 'echo hi' } },
      sessionMeta: { childId: 'step-1-synthetic', synthetic: true, command: 'shell' },
    });
    const harness = makeHarness({ step, status: 'running' });
    const result = await harness.manager.recover();
    expect(result).toEqual({ hasResume: false, hasFailure: true });
    expect(harness.followups).toHaveLength(0);
    expect(harness.getState().executedSteps[0]?.status).toBe('failed');
    expect(harness.getState().executedSteps[0]?.error).toContain('not recoverable');
  });

  it('leaves paused steps untouched (no followup)', async () => {
    const harness = makeHarness({ step: makeFailedStep({ status: 'paused' }), status: 'paused' });
    const result = await harness.manager.recover();
    expect(result).toEqual({ hasResume: false, hasFailure: false });
    expect(harness.followups).toHaveLength(0);
    expect(harness.getState().executedSteps[0]?.status).toBe('paused');
  });

  it('follows up all running/interacting subagent steps when multiple are running (defect 10 multi-path recovery)', async () => {
    const first = makeFailedStep({ status: 'running', id: 'exec-1', sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' } });
    const second = makeFailedStep({ status: 'running', id: 'exec-2', stepId: 'step-2', sessionMeta: { childId: 'child-2', synthetic: false, command: 'agent' } });
    const harness = makeHarness({ step: first, status: 'running' });
    harness.setState(makeMultiState([first, second], 'running'));

    const result = await harness.manager.recover();

    // 缺陷 10 多路恢复：并发落地后多个 running Step 全部被 followup
    // （原 `.find()` 只取第一个 → 其余 running 不 followup → 半恢复态卡死）。
    expect(result).toEqual({ hasResume: true, hasFailure: false });
    expect(harness.followups).toHaveLength(2);
    const followedChildIds = harness.followups.map(f => f.childId).sort();
    expect(followedChildIds).toEqual(['child-1', 'child-2']);
  });

  it('does not followup subagent steps when a synthetic step is unrecoverable', async () => {
    const synthetic = makeFailedStep({
      status: 'running',
      id: 'exec-shell',
      stepId: 'step-shell',
      command: { type: 'shell', value: { command: 'echo hi' } },
      sessionMeta: { childId: 'step-shell-synthetic', synthetic: true, command: 'shell' },
    });
    const agent = makeFailedStep({ status: 'running', id: 'exec-agent', stepId: 'step-agent', sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' } });
    const harness = makeHarness({ step: synthetic, status: 'running' });
    harness.setState(makeMultiState([synthetic, agent], 'running'));

    const result = await harness.manager.recover();

    expect(result).toEqual({ hasResume: false, hasFailure: true });
    expect(harness.followups).toHaveLength(0);
    const state = harness.getState();
    expect(state.executedSteps.find(item => item.id === 'exec-shell')?.status).toBe('failed');
    // 合成 session 失败时整体失败，子代理 Step 保持 running（不 followup、不半恢复）。
    expect(state.executedSteps.find(item => item.id === 'exec-agent')?.status).toBe('running');
  });
});

describe('synthesizeChildId', () => {
  it('produces the step-prefixed 8-hex childId shape', () => {
    expect(synthesizeChildId('step-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
