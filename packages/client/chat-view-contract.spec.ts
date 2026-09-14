/**
 * `chat-view-contract.ts` 纯逻辑单测（B1 本地契约层）：
 * - ChatSnapshot 结构守卫（order + nodes.get/source）与 EMPTY order 常量；
 * - 引擎 ChatNode（未知形状）→ 本地 view-node / location / turn 叶子映射；
 * - 占位行预览（B1 通用调试行的纯文本摘要，B2 逐 kind 视觉交付后移除）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat-view-contract.spec
 */
import { describe, expect, it } from 'vitest';

import {
  STEP_CHAT_EMPTY_ORDER,
  isStepChatSnapshotLike,
  stepChatLocationViewOf,
  stepChatNodePreview,
  stepChatTurnOf,
  stepChatViewNodeOf,
  type StepChatObservableSourceLike,
  type StepChatViewNode,
} from './chat-view-contract.ts';

/** 空 per-key 源（守卫用例的占位订阅面）。 */
const EMPTY_SOURCE: StepChatObservableSourceLike<unknown> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};

describe('isStepChatSnapshotLike（ChatSnapshot 结构守卫）', () => {
  it('accepts a ChatSnapshot-shaped value (order array + nodes.get/source)', () => {
    expect(isStepChatSnapshotLike({
      order: ['a', 'b'],
      nodes: { get: () => undefined, source: () => EMPTY_SOURCE },
      timeline: { turnOrder: [], turns: new Map() },
      legacy: { nodes: [] },
    })).toBe(true);
  });

  it('rejects non-objects and values missing the order array', () => {
    expect(isStepChatSnapshotLike(undefined)).toBe(false);
    expect(isStepChatSnapshotLike(null)).toBe(false);
    expect(isStepChatSnapshotLike('chat')).toBe(false);
    expect(isStepChatSnapshotLike({ nodes: { get: () => undefined, source: () => EMPTY_SOURCE } })).toBe(false);
    expect(isStepChatSnapshotLike({ order: 'a,b', nodes: {} })).toBe(false);
  });

  it('rejects a legacy-only slice (nodes store without get/source functions)', () => {
    // rc.1 target 的 ChatSnapshot 恒带 nodes store；legacy 切片本身不算 ChatSnapshot。
    expect(isStepChatSnapshotLike({ legacy: { nodes: [{ kind: 'user' }] } })).toBe(false);
    expect(isStepChatSnapshotLike({ order: [], nodes: { get: 1, source: 2 } })).toBe(false);
  });
});

describe('stepChatLocationViewOf / stepChatViewNodeOf / stepChatTurnOf（view-node 映射）', () => {
  const stepNode = (key = 'user:1', kind = 'user', anchorSeq = 3): Record<string, unknown> => ({
    key,
    kind,
    target: 'chat',
    id: key,
    anchorSeq,
    data: { kind, seq: anchorSeq },
    location: {
      kind: 'step',
      turn: { turn: 2, status: 'open', start: { time: 100 }, end: undefined, steps: [], data: {} },
      step: { step: 1, status: 'open', start: { time: 100 }, end: undefined, data: {} },
    },
    visibility: 'visible',
  });

  it('maps an engine node to the local view face (kind/key/data/anchorSeq/location)', () => {
    const view = stepChatViewNodeOf(stepNode());
    expect(view).toEqual({
      key: 'user:1',
      kind: 'user',
      data: { kind: 'user', seq: 3 },
      anchorSeq: 3,
      location: { kind: 'step', turn: 2, step: 1 },
    });
    expect(view?.location?.kind).toBe('step');
  });

  it('keeps the data reference live (no engine object copy)', () => {
    const data = { kind: 'user', seq: 3 };
    const view = stepChatViewNodeOf(stepNode()) as StepChatViewNode;
    expect(view.data).not.toBe(data); // 引擎负载对象原样透出
    expect(stepChatViewNodeOf({ ...stepNode(), data })?.data).toBe(data);
  });

  it('derives the turn number from a step/turn location and omits it otherwise', () => {
    const raw = stepNode();
    expect(stepChatTurnOf(raw)).toBe(2);
    expect(stepChatLocationViewOf(raw.location)?.turn).toBe(2);
    // turn 级 location：无 step 字段。
    expect(stepChatLocationViewOf({
      kind: 'turn',
      turn: { turn: 4, status: 'closed', steps: [], data: {} },
    })).toEqual({ kind: 'turn', turn: 4 });
    // session/unresolved：无 turn。
    expect(stepChatLocationViewOf({ kind: 'session' })).toEqual({ kind: 'session' });
    expect(stepChatLocationViewOf({ kind: 'unresolved' })).toEqual({ kind: 'unresolved' });
    expect(stepChatLocationViewOf(undefined)).toBeUndefined();
    expect(stepChatLocationViewOf({ kind: '', turn: { turn: 1 } })).toBeUndefined();
  });

  it('rejects non-node shapes (missing key/kind or a non-finite anchorSeq)', () => {
    expect(stepChatViewNodeOf(undefined)).toBeUndefined();
    expect(stepChatViewNodeOf(null)).toBeUndefined();
    expect(stepChatViewNodeOf({ kind: 'user', anchorSeq: 1 })).toBeUndefined();
    expect(stepChatViewNodeOf({ key: '', kind: 'user', anchorSeq: 1 })).toBeUndefined();
    expect(stepChatViewNodeOf({ key: 'a', anchorSeq: 1 })).toBeUndefined();
    expect(stepChatViewNodeOf({ key: 'a', kind: 'user', anchorSeq: Number.NaN })).toBeUndefined();
    // 打断/合成锚点可为小数（CHAT_SYNTHETIC_SEQ_OFFSETS 语义）。
    expect(stepChatViewNodeOf({ key: 'a', kind: 'assistant-step', anchorSeq: 3.1 })?.anchorSeq).toBe(3.1);
  });
});

describe('stepChatNodePreview（B1 占位行摘要）', () => {
  const view = (kind: string, data: unknown): StepChatViewNode => ({
    key: `${kind}:1`,
    kind,
    data,
    anchorSeq: 1,
    location: undefined,
  });

  it('extracts assistant text blocks and tool-call counts', () => {
    expect(stepChatNodePreview(view('assistant-step', {
      status: 'running',
      turn: 1,
      step: 0,
      blocks: [
        { kind: 'text', text: '第一段' },
        { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '' },
      ],
    }))).toBe('第一段 [tool-call ×1]');
  });

  it('extracts user/steering/context content text blocks (type-based shape)', () => {
    expect(stepChatNodePreview(view('user', {
      content: [{ type: 'text', text: '帮我看看' }],
    }))).toBe('帮我看看');
    expect(stepChatNodePreview(view('steering', {
      content: [{ type: 'text', text: '继续' }, { type: 'image' }],
    }))).toBe('继续');
    expect(stepChatNodePreview(view('context', { content: [] }))).toBeUndefined();
  });

  it('summarizes tool/command/compaction rows and returns undefined for silent rows', () => {
    expect(stepChatNodePreview(view('tool-call', {
      root: { kind: 'tool-result', callId: 'c1', name: 'read', content: [] },
    }))).toBe('✓ read');
    expect(stepChatNodePreview(view('tool-call', {
      root: { callId: 'c2', name: 'bash', argsRaw: '' },
    }))).toBe('… bash');
    expect(stepChatNodePreview(view('command', {
      name: 'plan', args: '', outcome: { kind: 'success', text: 'ok' },
    }))).toBe('✓ /plan');
    expect(stepChatNodePreview(view('turn-tail', { turn: 3 }))).toBe('(turn 3 closed)');
    expect(stepChatNodePreview(view('turn-error', { message: 'provider down' }))).toBe('provider down');
    expect(stepChatNodePreview(view('unknown', { type: 'some/event', data: 1 }))).toBe('(unknown: some/event)');
    expect(stepChatNodePreview(view('turn-max-tokens', { turn: 1 }))).not.toBeUndefined();
  });

  it('clips long text and returns undefined for unrecognizable payloads', () => {
    const long = '字'.repeat(300);
    const clipped = stepChatNodePreview(view('assistant-step', { blocks: [{ kind: 'text', text: long }] }));
    expect(clipped?.length ?? 0).toBeLessThan(160);
    expect(clipped?.endsWith('…')).toBe(true);
    expect(stepChatNodePreview(view('future-kind', { n: 1 }))).toBeUndefined();
    expect(stepChatNodePreview(view('assistant-step', { blocks: [] }))).toBeUndefined();
  });
});

describe('STEP_CHAT_EMPTY_ORDER', () => {
  it('is a shared empty frozen array (stable fallback identity)', () => {
    expect(STEP_CHAT_EMPTY_ORDER).toEqual([]);
    expect(STEP_CHAT_EMPTY_ORDER.length).toBe(0);
  });
});
