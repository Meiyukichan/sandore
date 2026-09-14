/**
 * 工具返回值的 **lossless JSON** 约束（真机缺陷回归测试）。
 *
 * 背景（用户实例 `052d432f-2333-41a1-b23e-e66675e6d3f0` 实测）：`sandore_workflow_status`
 * 的 `detail='steps'` 在真实工作流上**整次调用失败**，模型看到的是
 * `tool "sandore_workflow_status" returned invalid output: value is not lossless JSON`。
 * 根因：`parallel1` 是 shell 步骤，`sessionMeta` 里没有 `childId`，而投影写成
 * `{ childSessionId: step.sessionMeta.childId }` → 产出值为 `undefined` 的键 →
 * DSH 的 `snapshotJsonValue` 拒绝整个返回值。
 *
 * 本文件锁两件事：
 * 1. 投影层不再漏出值为 `undefined` 的键（`steps` / `step` / `summary` 三档都断言 lossless）；
 * 2. 工具 execute 边界（`losslessExecute`）对任何漏网值兜底，避免再次升级成「整次调用失败」。
 *
 * 判据镜像：DSH `packages/util/values`（`snapshotJsonValue`）——只接受 `null`/布尔/有限且
 * 非 -0 的数字/字符串/稠密本域数组/普通（或 null 原型）对象的可枚举字符串键；环引用、
 * 稀疏数组、symbol 与非枚举自有属性、函数、类实例一律拒绝。此处**独立实现**（不复用被测
 * 代码），否则测试会与被测实现一起错。
 * @module @meiyukichan/dsh-sandore/workflow/src/tool-support.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowTaskState } from './schema.ts';
import type { ExecutedStepDefault } from './types.ts';
import type { SandoreToolHost } from './tool-support.ts';
import { losslessEnvelope, losslessExecute, toLosslessJsonValue } from './tool-support.ts';
import { executeStatusTool } from './status-tool.ts';

// ── DSH lossless JSON 判据的独立镜像 ───────────────────────────────────────────

/** 返回第一处违规的位置，合法则返回 null。 */
function losslessViolation(value: unknown, at = '$', seen: Set<object> = new Set()): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      if (!Number.isFinite(value)) return `${at}: 非有限数字`;
      return Object.is(value, -0) ? `${at}: 负零` : null;
    case 'undefined':
      return `${at}: undefined`;
    case 'function':
    case 'symbol':
    case 'bigint':
      return `${at}: ${typeof value}`;
    case 'object':
      break;
    default:
      return `${at}: ${typeof value}`;
  }
  const object = value as object;
  if (seen.has(object)) return `${at}: 环引用`;
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) return `${at}: 非本域数组`;
      if (Object.keys(object).length !== object.length) return `${at}: 稀疏数组`;
      for (let index = 0; index < object.length; index += 1) {
        const violation = losslessViolation(object[index], `${at}[${index}]`, seen);
        if (violation !== null) return violation;
      }
      return null;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      return `${at}: 非普通对象（${prototype?.constructor?.name ?? 'unknown'}）`;
    }
    for (const key of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable) return `${at}.${key}: 非可枚举自有属性`;
      const violation = losslessViolation((object as Record<string, unknown>)[key], `${at}.${key}`, seen);
      if (violation !== null) return violation;
    }
    return Object.getOwnPropertySymbols(object).length === 0 ? null : `${at}: symbol 键`;
  } finally {
    seen.delete(object);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** shell 步骤段（真机缺陷现场：`sessionMeta` 有 `synthetic`/`command`，**没有** `childId`）。 */
function shellSegment(): ExecutedStepDefault {
  return {
    id: 'seg-shell',
    stepId: 'step-parallel1',
    stageId: 'stg-a',
    name: 'parallel1',
    status: 'completed',
    visitCount: 1,
    createdAt: 't0',
    sessionMeta: { synthetic: true, command: 'shell' },
  };
}

/** prompt 步骤段（有子会话）。 */
function promptSegment(): ExecutedStepDefault {
  return {
    id: 'seg-prompt',
    stepId: 'step-sce1',
    stageId: 'stg-a',
    name: 'sce1',
    status: 'completed',
    visitCount: 1,
    createdAt: 't1',
    sessionMeta: { synthetic: false, command: 'prompt', childId: 'child-1', hostSessionId: 'inst-1' },
  };
}

function makeState(): WorkflowTaskState {
  return {
    taskId: 'inst-1',
    hostSessionId: 'inst-1',
    workflowId: 'wfl-1',
    cwd: '/w',
    status: 'completed',
    originalInput: 'do it',
    currentStageId: 'stg-a',
    executedSteps: [promptSegment(), shellSegment()],
    stageInfos: [{ id: 'stg-a', name: 'StageA', status: 'completed' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt: 't0',
    updatedAt: 't2',
  };
}

/** 只为 status 工具服务的最小 fake host。 */
function makeHost(state: WorkflowTaskState): SandoreToolHost {
  return {
    startInstance: vi.fn(async () => ({ instanceId: 'inst-1', status: 'pending' as const })),
    runInstanceInSession: vi.fn(async () => ({ instanceId: 'inst-1', status: 'running' as const })),
    getState: vi.fn(() => { throw new Error('not stubbed'); }),
    getInstanceState: vi.fn(() => state),
    hydrateStateMessages: vi.fn(async (candidate: WorkflowTaskState) => candidate),
    findInstanceIdByHostSession: vi.fn((sessionId: string) => (sessionId === 'sess-1' ? 'inst-1' : undefined)),
    pauseStep: vi.fn(async () => {}),
    pauseAllSteps: vi.fn(async () => {}),
    resumeStep: vi.fn(async () => {}),
    resumeAllSteps: vi.fn(async () => {}),
    retryStep: vi.fn(async () => {}),
    sendStepMessage: vi.fn(async () => {}),
    persistence: () => undefined,
  };
}

/** 顶层主代理调用方（gate 放行）。 */
const topLevelExec = { agent: { session: { id: 'sess-1', header: { cwd: '/w' } } } };

// ── 规整函数本身 ───────────────────────────────────────────────────────────────

describe('toLosslessJsonValue（工具返回值规整）', () => {
  it('drops undefined-valued keys and undefined/symbol/function values entirely', () => {
    const cleaned = toLosslessJsonValue({
      kept: 1,
      missing: undefined,
      fn: () => {},
      sym: Symbol('s'),
      nested: { a: 'x', b: undefined },
    });
    expect(cleaned).toEqual({ kept: 1, nested: { a: 'x' } });
    expect(losslessViolation(cleaned)).toBeNull();
  });

  it('degrades Date, Error, non-finite numbers and -0 instead of failing the call', () => {
    const cleaned = toLosslessJsonValue({
      at: new Date('2026-01-01T00:00:00.000Z'),
      err: new Error('boom'),
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      negZero: -0,
      big: 10n,
    });
    expect(cleaned).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      err: 'boom',
      nan: null,
      inf: null,
      negZero: null,
      big: '10',
    });
    expect(losslessViolation(cleaned)).toBeNull();
  });

  it('makes sparse arrays dense and breaks cycles', () => {
    const sparse: unknown[] = [];
    sparse[2] = 'c';
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const cleaned = toLosslessJsonValue({ sparse, cyclic }) as { sparse: unknown[]; cyclic: Record<string, unknown> };
    expect(cleaned.sparse).toEqual([null, null, 'c']);
    expect(cleaned.cyclic).toEqual({ name: 'root' });
    expect(losslessViolation(cleaned)).toBeNull();
  });

  it('copies own enumerable keys of a class instance (never emits the instance itself)', () => {
    class Meta {
      constructor(readonly command: string, readonly childId?: string) {}
    }
    const cleaned = toLosslessJsonValue({ meta: new Meta('shell') });
    expect(cleaned).toEqual({ meta: { command: 'shell' } });
    expect(losslessViolation(cleaned)).toBeNull();
  });
});

describe('losslessExecute（execute 边界兜底）', () => {
  it('cleans a leaked undefined so DSH never sees a non-lossless tool result', async () => {
    const result = await losslessExecute(async () => ({
      ok: true,
      action: 'status',
      data: { instanceId: 'inst-1', childSessionId: undefined, rows: [{ a: 1, b: undefined }] },
    }));
    expect(losslessViolation(result)).toBeNull();
    expect(result.data).toEqual({ instanceId: 'inst-1', rows: [{ a: 1 }] });
    expect(losslessViolation(losslessEnvelope({ ok: false, reason: 'x' }))).toBeNull();
  });
});

// ── 真机缺陷回归：shell 段没有 childId ─────────────────────────────────────────

describe('sandore_workflow_status 在含 shell 段的实例上仍返回合法 lossless JSON', () => {
  it("detail='steps' no longer leaks childSessionId: undefined (real-machine regression)", async () => {
    const host = makeHost(makeState());
    const result = await executeStatusTool(host, { detail: 'steps' }, topLevelExec);

    expect(result.ok).toBe(true);
    expect(losslessViolation(result)).toBeNull();

    const rows = (result.data as { steps: Array<Record<string, unknown>> }).steps;
    const shellRow = rows.find(row => row.stepId === 'step-parallel1')!;
    const promptRow = rows.find(row => row.stepId === 'step-sce1')!;
    // shell 段：**不输出**该键（而不是输出 undefined）。
    expect('childSessionId' in shellRow).toBe(false);
    expect(Object.values(shellRow)).not.toContain(undefined);
    // prompt 段照旧带子会话 id。
    expect(promptRow.childSessionId).toBe('child-1');
  });

  it("detail='step' keeps shell sessionMeta lossless (no undefined values inside meta)", async () => {
    const host = makeHost(makeState());
    const result = await executeStatusTool(host, { detail: 'step', stepId: 'step-parallel1' }, topLevelExec);

    expect(result.ok).toBe(true);
    expect(losslessViolation(result)).toBeNull();
    const latest = (result.data as { latest: Record<string, unknown> }).latest;
    expect(latest.sessionMeta).toEqual({ synthetic: true, command: 'shell' });
    expect('childSessionId' in latest).toBe(false);
  });

  it("detail='summary' stays lossless too", async () => {
    const host = makeHost(makeState());
    const result = await executeStatusTool(host, { detail: 'summary' }, topLevelExec);
    expect(result.ok).toBe(true);
    expect(losslessViolation(result)).toBeNull();
  });
});
