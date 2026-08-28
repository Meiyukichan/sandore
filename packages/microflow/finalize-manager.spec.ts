/**
 * finalize-manager.ts（FinalizeAssessor + GateEvaluator + FinalizeManager）的单元测试。
 *
 * 覆盖解析纯函数（parseAssessResult 三级回退 / parseSecondaryGate）、
 * FinalizeAssessor（session 类型 fork 会话 / fork 抛错降级 / shell 临时会话 / ask 载荷）、
 * GateEvaluator（primary 纯代码产物校验 [零 AI] + secondary AI 门禁审查）与
 * finalizeStep 编排（跳过 / ask 中断门禁 / 完整 finalize 的 finalizeMeta 回写 /
 * 透传变量回写保留 refresh）。
 * @module dsh-sandore/microflow/src/finalize-manager.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FinalizeAssessor, FinalizeManager, GateEvaluator, buildFinalizeRetryHint, buildSecondaryGateCorrectionHint, explainFinalizeResultParse, explainSecondaryGateParse, parseAssessResult, parseSecondaryGate } from './finalize-manager.ts';
import type { FinalizeManagerConfig } from './finalize-manager.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome } from './file-utils.ts';
import type { PassThroughVarValue } from './stage-executor.ts';
import type { ContinuableStart, ContinuableStartSpec } from './subagents.ts';
import type { ExecutedStepDefault } from '../workflow/types';
import type { FinalizeAssessResult, GateEvalResult, WorkflowStep } from '../workflow/schema';

/** 记录 fork 调用并返回可注入 fork 结果的极简会话存储。 */
class FakeForkedSession {
  constructor(readonly id: string) {}
}

/** 内存 mock SessionStore：仅实现 `fork`，返回 `{ id }` 会话，供 `ctx.provide('sessions', …)` 注入。 */
class FakeSessionStore {
  readonly forkedSources: string[] = [];
  private counter = 0;
  forkHandler: (source: string) => FakeForkedSession = () => {
    this.counter += 1;
    return new FakeForkedSession(`session-${this.counter}`);
  };

  fork(source: string): FakeForkedSession {
    this.forkedSources.push(source);
    return this.forkHandler(source);
  }
}

/** 内存文件系统（target 导向两段式协议）：`files` 存文件内容，`dirs` 存目录。 */
class FakeFs implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  seedFile(path: string, content = ''): void {
    this.files.set(path, content);
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      this.dirs.add(segments.slice(0, i).join('/'));
    }
  }

  async resolve(path: string): Promise<FsTarget> {
    const normalized = path.replace(/\/+$/, '') || '/';
    return { targetKey: normalized, displayPath: normalized };
  }

  processPath(target: FsTarget): string {
    return target.displayPath;
  }

  async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const prefix = target.targetKey === '/' ? '' : `${target.targetKey}/`;
    const names = new Set<string>();
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) {
        const name = dir.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    return [...names].sort().map(name => {
      const full = prefix + name;
      const isDir = this.dirs.has(full);
      return { name, type: isDir ? 'directory' : 'file', target: { targetKey: full, displayPath: full } };
    });
  }

  async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.targetKey);
    if (content === undefined) throw new Error(`FS_NOT_FOUND: ${target.displayPath}`);
    return content;
  }

  async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null;
    this.seedFile(target.targetKey, content);
    return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content };
  }
}

/** 记录 startContinuable 调用并返回可注入 childId 的最小 subagents mock。 */
class FakeGateSubagents {
  /** 每次 `startContinuable` 记录的委派请求（prompt/parent/agentOptions 断言用）。 */
  readonly starts: ContinuableStartSpec[] = [];
  /**
   * `startContinuable` 创建子代理时的回复钩子：返回非空 ContentBlock[] 时预填
   * child.session.events 的 assistant 消息（供 `finalAssistantOutput` 读取——mock 不
   * 后台驱动 agent loop，子代理输出由测试预填）。缺省 undefined → 子代理无输出。
   */
  outputHandler?: () => ContentBlock[] | undefined;
  /** 若设置，`startContinuable` 抛出该错误（模拟 secondary 门禁子代理启动失败）。 */
  startError?: Error;
  /** followup 记录（重试纠正断言用）。 */
  readonly followups: Array<{ childId: SessionId; content: ContentBlock[] }> = [];
  /**
   * followup 时的回复钩子（重试场景：纠正后产出合法 JSON）；缺省 undefined → 不追加输出。
   */
  followupHandler?: () => ContentBlock[] | undefined;

  constructor(private readonly agents: FakeAgentRegistry) {}

  async followup(_parent: Agent, childId: SessionId, content: ContentBlock[], _options: SubagentFollowupOptions): Promise<MessageId> {
    this.followups.push({ childId, content });
    const agent = this.agents.get(childId);
    const reply = this.followupHandler?.();
    if (agent !== undefined && reply !== undefined && reply.length > 0) {
      agent.session.append(assistantMessageEvent(reply, agent.session.events.length, Date.now()));
    }
    return `msg-${this.followups.length}`;
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    if (this.startError !== undefined) {
      throw this.startError;
    }
    this.starts.push(spec);
    // 与 FakeSubagents 同形：childId = `child-{index}`（真实 childId 语义，供
    // gateSessionId 断言）。
    const childId = `child-${this.starts.length}`;
    const agent = new FakeAgent(childId);
    const reply = this.outputHandler?.();
    if (reply !== undefined && reply.length > 0) {
      agent.session.append(assistantMessageEvent(reply, 0, Date.now()));
    }
    // 注册进 agents registry：awaitGateOutput 经 ctx.agents.get(childId) 取 child。
    this.agents.register(agent);
    return { childId, messageId: `msg-${this.starts.length}` };
  }
}

/** 组装一条 Step 定义（补齐必填字段 `id`）。 */
function step(fields: {
  id?: string;
  command?: WorkflowStep['command'];
  passThroughVars?: WorkflowStep['passThroughVars'];
  outputTo?: WorkflowStep['outputTo'];
  gates?: WorkflowStep['gates'];
} = {}): WorkflowStep {
  return {
    id: fields.id ?? 'step-a',
    ...(fields.command === undefined ? {} : { command: fields.command }),
    ...(fields.passThroughVars === undefined ? {} : { passThroughVars: fields.passThroughVars }),
    ...(fields.outputTo === undefined ? {} : { outputTo: fields.outputTo }),
    ...(fields.gates === undefined ? {} : { gates: fields.gates }),
  };
}

/** 组装一条已执行 Step 快照（补齐必填字段）。 */
function executedStep(fields: {
  status?: ExecutedStepDefault['status'];
  command?: ExecutedStepDefault['command'];
} = {}): ExecutedStepDefault {
  return {
    type: 'default',
    id: 'step-a-exec',
    stepId: 'step-a',
    stageId: 'stg-1',
    name: 'Step A',
    status: fields.status ?? 'completed',
    ...(fields.command === undefined ? {} : { command: fields.command }),
    visitCount: 1,
  };
}

/** 组装 finalize-manager 测试环境（注入 mock llm/sessions/fs/agents/subagents 与固定引擎默认 provider/model）。 */
function harness(config: FinalizeManagerConfig = {}): {
  ctx: Context;
  llm: FakeLlm;
  sessions: FakeSessionStore;
  fs: FakeFs;
  agents: FakeAgentRegistry;
  subagents: FakeGateSubagents;
  assessor: FinalizeAssessor;
  gateEvaluator: GateEvaluator;
  manager: FinalizeManager;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const sessions = new FakeSessionStore();
  const fs = new FakeFs();
  const agents = new FakeAgentRegistry();
  const subagents = new FakeGateSubagents(agents);
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('fs', fs as unknown as FileSystem);
  ctx.provide('agents', agents);
  ctx.provide('subagents', subagents);
  const fullConfig: FinalizeManagerConfig = {
    defaultTimeoutMs: 60000,
    defaultProvider: 'p',
    defaultModel: 'm',
    // secondary 门禁 startContinuable 的 request.parent（最小 Agent 桩；Phase B
    // assessForked 仍走 hostAgentId/createAgent 旧机制，不受本字段影响）。
    hostAgent: new FakeAgent('host-1'),
    ...config,
  };
  return {
    ctx,
    llm,
    sessions,
    fs,
    agents,
    subagents,
    assessor: new FinalizeAssessor(ctx, fullConfig),
    gateEvaluator: new GateEvaluator(ctx, fullConfig),
    manager: new FinalizeManager(ctx, fullConfig),
  };
}

/** DSH 形状的会话事件（seed 截断测试用：仅需 type/seq/time/data 包络）。 */
type SeedEvent = { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown };

/** 构造一条 `turn/start` / `turn/end` 边界事件。 */
function boundaryEvent(type: 'turn/start' | 'turn/end', seq: number, data: unknown = {}): SeedEvent {
  return { type, seq, time: 0, data };
}

/** 构造一条 `assistant/message` 事件（text 输出）。 */
function messageEvent(seq: number, text: string): SeedEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 0, step: 0, message: { id: `m-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'mock', model: 'mock' } } },
  };
}

describe('parseAssessResult', () => {
  it('extracts hasAsk, passThroughVars and askQuestion from JSON', () => {
    const result = parseAssessResult(
      '{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}',
    );
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.askQuestion).toBeUndefined();
  });

  it('preserves askQuestion id/question/options fields when hasAsk is true', () => {
    const result = parseAssessResult(
      '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}',
    );
    expect(result.hasAsk).toBe(true);
    expect(result.askQuestion?.questions[0]).toMatchObject({ id: 'q1', question: '选择分支' });
    expect(result.askQuestion?.questions[0]?.options).toEqual([{ label: 'A' }]);
  });

  it('falls back to legacy completionType when JSON omits hasAsk (兼容旧输出)', () => {
    const result = parseAssessResult(
      '{"completionType":"ask","passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}',
    );
    expect(result.hasAsk).toBe(true);
    expect(result.askQuestion?.questions[0]).toMatchObject({ id: 'q1', question: '选择分支' });
    expect(result.askQuestion?.questions[0]?.options).toEqual([{ label: 'A' }]);
  });

  it('falls back to regex hasAsk when JSON is wrapped in prose', () => {
    const result = parseAssessResult('结果如下：\n{"hasAsk": true}\n请查收');
    expect(result.hasAsk).toBe(true);
    expect(result.passThroughVars).toEqual({});
  });

  it('falls back to legacy regex completionType when JSON is wrapped in prose', () => {
    const result = parseAssessResult('结果如下：\n{"completionType": "ask"}\n请查收');
    expect(result.hasAsk).toBe(true);
    expect(result.passThroughVars).toEqual({});
  });

  it('falls back to hasAsk=false with empty vars for plain output', () => {
    const result = parseAssessResult('  plain text  ');
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({});
  });

  it('preserves askQuestion header/option description/multi_select fields', () => {
    const result = parseAssessResult(
      '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择","header":"请选择","options":[{"label":"A","description":"方案A"},{"label":"B"}],"multi_select":true}]}}',
    );
    expect(result.askQuestion?.questions[0]).toMatchObject({
      id: 'q1',
      question: '选择',
      header: '请选择',
      multi_select: true,
    });
    expect(result.askQuestion?.questions[0]?.options).toEqual([
      { label: 'A', description: '方案A' },
      { label: 'B' },
    ]);
  });

  // ── 严重缺陷：```json markdown 围栏输出下 askQuestion/passThroughVars 被丢弃 ──
  // 修前裸 JSON.parse 失败 → regex 回退只恢复完成判定、askQuestion 丢失
  // → 假 ask → findAskStep 未命中 → 实例永久卡 interacting。修后围栏剥离再解析。

  it('parses askQuestion and passThroughVars from a ```json-fenced output', () => {
    const result = parseAssessResult(
      '```json\n{"hasAsk":true,"passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}\n```',
    );
    expect(result.hasAsk).toBe(true);
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.askQuestion?.questions[0]).toMatchObject({ id: 'q1', question: '选择分支' });
    expect(result.askQuestion?.questions[0]?.options).toEqual([{ label: 'A' }]);
  });

  it('parses a fenced JSON block wrapped in surrounding prose', () => {
    const result = parseAssessResult(
      '收尾评估结果：\n```json\n{"hasAsk":false,"passThroughVars":{"a":"b"}}\n```\n请查收',
    );
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({ a: 'b' });
  });

  it('parses compressedOutput from the merged Phase B JSON (Phase A 结果也透传压缩摘要)', () => {
    const result = parseAssessResult(
      '{"hasAsk":false,"passThroughVars":{"projectName":"sandore"},"compressedOutput":"压缩摘要"}',
    );
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.compressedOutput).toBe('压缩摘要');
  });

  it('omits compressedOutput when the JSON lacks it (缺省 undefined)', () => {
    expect(parseAssessResult('{"hasAsk":false,"passThroughVars":{}}').compressedOutput).toBeUndefined();
    expect(parseAssessResult('非 JSON 输出').compressedOutput).toBeUndefined();
  });

  it('tolerates an uppercase fence language tag', () => {
    const result = parseAssessResult(
      '```JSON\n{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"Q"}]}}\n```',
    );
    expect(result.hasAsk).toBe(true);
    expect(result.askQuestion?.questions[0]?.id).toBe('q1');
  });

  it('falls back to hasAsk=false when the fenced block contains invalid JSON', () => {
    const result = parseAssessResult('```json\n{not valid json}\n```');
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({});
    expect(result.askQuestion).toBeUndefined();
  });

  it('keeps regex fallback behavior for unfenced prose without valid JSON', () => {
    const result = parseAssessResult('结果如下：\n这里没有 JSON\n请查收');
    expect(result.hasAsk).toBe(false);
    expect(result.passThroughVars).toEqual({});
  });
});

describe('parseSecondaryGate', () => {
  it('parses gateStatus done as passed for the secondary gate', () => {
    expect(parseSecondaryGate('{"gateStatus":"done"}').passed).toBe(true);
    expect(parseSecondaryGate('{"gateStatus":"error","gateDetail":"needs review"}')).toEqual({
      passed: false,
      detail: 'needs review',
    });
  });

  it('parses fenced outputs for the secondary gate (fence stripping is shared)', () => {
    expect(parseSecondaryGate('```json\n{"gateStatus":"done"}\n```').passed).toBe(true);
  });

  // primary 门禁已改为纯代码产物校验（无 AI 输出可解析）——parsePrimaryGate 已删除。
});

describe('FinalizeAssessor.assess（Phase A 临时会话，不 fork）', () => {
  it('does not fork the step session for a session-type step (temp session, eval handle)', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'out', artifacts: ['a.md'] },
    });

    // Phase A 评估不再 fork：sessions.fork 零调用，临时会话句柄（eval-）。
    expect(sessions.forkedSources).toEqual([]);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.hasAsk).toBe(false);
  });

  it('does not fork for a prompt-type step either (决策 D3: prompt 为真实子代理会话，但 Phase A 临时会话)', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'prompt', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'out' },
    });

    expect(sessions.forkedSources).toEqual([]);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.hasAsk).toBe(false);
  });

  it('never calls sessions.fork and leaves the LLM request without a sessionId (temp session)', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'missing-session',
      context: { input: 'req', output: 'out' },
    });

    expect(sessions.forkedSources).toEqual([]);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toBeUndefined();
    expect(llm.calls[0]?.sessionId).toBeUndefined();
  });

  it('uses a temp session (no fork) for a shell-type step', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      context: { input: '', output: 'stdout', artifacts: [] },
    });

    expect(sessions.forkedSources).toHaveLength(0);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(llm.calls[0]?.sessionId).toBeUndefined();
  });

  it('includes the subagent return output text in the temp-session prompt (Phase A 输入 = 子代理返回结果)', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'agent final output', artifacts: ['a.md'] },
    });

    const prompt = (llm.calls[0]?.messages[0]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    // buildFinalizeContext 已含当前 step 子代理返回结果 output 文本 → 评估可见全部 I/O。
    expect(prompt).toContain('agent final output');
    expect(prompt).toContain('<ReferenceInfo>');
  });

  it('throws FINALIZE_FAILED when the assess stream finishes with error', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks('', { kind: 'error', failure: { message: 'boom', code: 'E1' } });

    await expect(
      assessor.assess({
        step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
        context: { input: '', output: '' },
      }),
    ).rejects.toMatchObject({ code: 'FINALIZE_FAILED', message: expect.stringContaining('boom') });
  });

  it('throws FINALIZE_FAILED when the assess stream is aborted', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks('', { kind: 'aborted', failure: { message: 'cancelled', code: 'E2' } });

    await expect(
      assessor.assess({
        step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
        context: { input: '', output: '' },
      }),
    ).rejects.toMatchObject({ code: 'FINALIZE_FAILED', message: expect.stringContaining('cancelled') });
  });

  it('assess 提示词只判断 ask 需求（Phase A 精简：不含变量提取/输出压缩/完成度检查）', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    await assessor.assess({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      context: { input: 'req', output: 'out' },
    });

    const prompt = (llm.calls[0]?.messages[0]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    // ask 判断：只判断输出本身是否是在向用户提问，保留 hasAsk 返回格式。
    expect(prompt).toContain('输出是否是在向用户提问');
    expect(prompt).toContain('"hasAsk"');
    // 2026-08-26：参考信息只注入 Output（不注入 Input/Artifacts——判断对象唯一是
    // step 返回的结果文本，输入/上下文会带偏判断）。
    expect(prompt).toContain('<Output>');
    expect(prompt).not.toContain('<Input>');
    expect(prompt).not.toContain('req');
    // 2026-08-25 精简：Phase A 不做透传变量提取/输出压缩（Phase B 职责，不复用 Phase A 结果）。
    expect(prompt).not.toContain('输出压缩');
    expect(prompt).not.toContain('compressedOutput');
    expect(prompt).not.toContain('【任务要求】');
    expect(prompt).not.toContain('透传变量');
    // 不判完成度：不要求判断任务是否真正完成、不要求完成度/质量检查。
    expect(prompt).not.toContain('是否真正完成');
    expect(prompt).not.toContain('已完成');
    expect(prompt).not.toContain('完成度');
    expect(prompt).not.toContain('质量');
  });
});

describe('FinalizeAssessor.assessForked（Phase B 真 fork 子代理）', () => {
  /** 组装完整闭合事件流（turn 0 闭合：start/user/assistant/end）。 */
  function closedEvents(): SeedEvent[] {
    return [
      boundaryEvent('turn/start', 0, { turn: 0 }),
      { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', content: [{ type: 'text', text: 'do it' }] } },
      messageEvent(2, 'step output'),
      boundaryEvent('turn/end', 3, { turn: 0, reason: { kind: 'completed' } }),
    ];
  }

  /** Phase B 收尾合并 JSON（透传变量 + 压缩摘要）。 */
  function phaseBJson(passThroughVars: string, compressedOutput: string): string {
    return `{"passThroughVars":${passThroughVars},"compressedOutput":"${compressedOutput}"}`;
  }

  it('replays the full closed-turn events as seed and drives a host subagent round (followup → whenIdle → finalAssistantOutput)', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => closedEvents(),
    });
    agents.createFollowupHandler = () => [{ type: 'text', text: phaseBJson('{"projectName":"sandore"}', '压缩摘要') }];

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
      workdir: '/tmp',
    });

    // agents.create 收到 seed = 完整事件 + meta.parentSession=宿主主代理 + origin='subagent'。
    expect(agents.createSeeds).toHaveLength(1);
    expect(agents.createSeeds[0]).toEqual(closedEvents());
    expect(agents.createMetas[0]).toEqual({ cwd: '/tmp', parentSession: 'host-1', seedLength: 4, origin: 'subagent' });
    // 合成 fork 会话 id：纯 UUID（globalThis.crypto.randomUUID()）。
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // 驱动一轮：followup 收到收尾处理提示词（含 <ReferenceInfo> 与 compressedOutput 格式），whenIdle 被 await。
    const forkedAgent = agents.createdAgents[0]!;
    expect(forkedAgent.followups).toHaveLength(1);
    const promptText = (forkedAgent.followups[0]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    // 2026-08-25：fork 版不注入参考信息节（上下文在会话里）；降级才注入。
    expect(promptText).not.toContain('<ReferenceInfo>');
    expect(promptText).toContain('compressedOutput');
    // Phase B 专用提示词不含 hasAsk 判断（Phase A 已处理）。
    expect(promptText).not.toContain('hasAsk');
    expect(promptText).not.toContain('是否需要向用户提问');
    // Phase B 提示词含四段式输出模板结构要求（一级标题：任务要求/执行过程/最终成果/未完成与遗留）。
    expect(promptText).toContain('# 任务要求');
    expect(promptText).toContain('# 执行过程');
    expect(promptText).toContain('# 最终成果');
    expect(promptText).toContain('# 未完成与遗留');
    expect(promptText).toContain('```md');
    expect(forkedAgent.whenIdleCount).toBe(1);
    // 一个 LLM 调用返回合并 JSON：passThroughVars + compressedOutput。
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.compressedOutput).toBe('压缩摘要');
    // 评估完 dispose：live 移除（持久化记录保留）。
    expect(agents.get(result.forkSessionId)).toBeUndefined();
    // 真 fork 子代理路径不消费 llm.stream（模型调用走子代理 followup）。
    expect(llm.calls).toHaveLength(0);
  });

  it('truncates the seed to the last closed turn/end when the source has an unclosed tail', async () => {
    const { agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => [
        ...closedEvents(),
        boundaryEvent('turn/start', 4, { turn: 1 }),
        messageEvent(5, 'in-flight output'),
      ],
    });
    agents.createFollowupHandler = () => [{ type: 'text', text: phaseBJson('{}', '摘要') }];

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    });

    // seed 截到最后一个闭合 turn/end（seq 0-3），未闭合尾部（turn/start 4 + assistant 5）不进 seed。
    expect(agents.createSeeds[0]).toEqual(closedEvents());
    expect(agents.createMetas[0]?.seedLength).toBe(4);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.compressedOutput).toBe('摘要');
  });

  it('degrades to a temp session with errorDetail when the source has no closed turn at all', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => [
        boundaryEvent('turn/start', 0, { turn: 0 }),
        messageEvent(1, 'in-flight output'),
      ],
    });
    llm.streamHandler = () => textChunks(phaseBJson('{}', '降级摘要'));

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    });

    // 无闭合 turn → 无法构造安全 seed → 降级临时会话（llm.stream 1 次）+ errorDetail（不失败）。
    expect(agents.createSeeds).toHaveLength(0);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('no closed turn');
    expect(result.compressedOutput).toBe('降级摘要');
    expect(llm.calls).toHaveLength(1);
  });

  it('degrades to a temp session with errorDetail when agents.create throws', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => closedEvents(),
    });
    agents.createError = new Error('create boom');
    llm.streamHandler = () => textChunks(phaseBJson('{}', '降级摘要'));

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    });

    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('create boom');
    expect(llm.calls).toHaveLength(1);
  });

  it('degrades to a temp session with errorDetail when hostAgentId/createAgent are not configured', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks(phaseBJson('{}', '降级摘要'));

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    });

    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('not configured');
    expect(llm.calls).toHaveLength(1);
  });

  it('degrades to a temp session with errorDetail when no event source exists (shell synthetic session)', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => undefined,
    });
    llm.streamHandler = () => textChunks(phaseBJson('{}', '降级摘要'));

    const result = await assessor.assessForked({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      stepSessionId: 'step-sh-abcdef01',
      context: { input: '', output: 'stdout' },
    });

    expect(agents.createSeeds).toHaveLength(0);
    expect(result.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('no event source');
    expect(llm.calls).toHaveLength(1);
  });

  it('follows up the same fork subagent with the JSON retry hint when the output is not parseable, then succeeds', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => closedEvents(),
    });
    // 首次返回非 JSON → followup 错误提示重试 → 第二次返回合法合并 JSON。
    let call = 0;
    agents.createFollowupHandler = () => {
      call += 1;
      return call === 1
        ? [{ type: 'text', text: 'not json at all' }]
        : [{ type: 'text', text: phaseBJson('{"projectName":"sandore"}', '重试后摘要') }];
    };

    const result = await assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    });

    // 同一个 fork 子代理 followup 两次（首次判断 + 1 次纠正重试）。
    const forkedAgent = agents.createdAgents[0]!;
    expect(forkedAgent.followups).toHaveLength(2);
    const hintText = (forkedAgent.followups[1]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    // 纠正提示动态携带解析失败原因（首次输出 'not json at all'）。
    expect(hintText).toContain('不是合法 JSON');
    expect(hintText).toContain('compressedOutput');
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.compressedOutput).toBe('重试后摘要');
    expect(llm.calls).toHaveLength(0);
  });

  it('explains finalize JSON parse failures with concrete reasons', () => {
    expect(explainFinalizeResultParse('{"passThroughVars": {}, "compressedOutput": "ok"}')).toBeUndefined();
    expect(explainFinalizeResultParse('not json')).toContain('不是合法 JSON');
    expect(explainFinalizeResultParse('{"passThroughVars": {}}')).toContain('缺少 compressedOutput');
    expect(explainFinalizeResultParse('{"compressedOutput": 123}')).toContain('不是字符串');
  });

  it('buildFinalizeRetryHint carries the concrete parse failure reason', () => {
    const hint = buildFinalizeRetryHint('{"passThroughVars": {}}');
    expect(hint).toContain('缺少 compressedOutput');
    expect(hint).toContain('{"passThroughVars": {}, "compressedOutput": "..."}');
    expect(hint).toContain('```json');
  });

  it('throws FINALIZE_FAILED when the Phase B JSON stays unparseable after 3 retries (超限报错，不降级)', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => closedEvents(),
    });
    // 始终返回非法 JSON → 首次 + 3 次 followup 重试均解析失败 → 超限报错（Step 落 failed）。
    agents.createFollowupHandler = () => [{ type: 'text', text: 'still not json' }];

    await expect(assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    })).rejects.toMatchObject({
      code: 'FINALIZE_FAILED',
      message: expect.stringContaining('JSON parse failed after 3 retry'),
    });

    // 首次 + 3 次重试共 4 次 followup；评估完 dispose（live 移除）。
    const forkedAgent = agents.createdAgents[0]!;
    expect(forkedAgent.followups).toHaveLength(4);
    expect(agents.get(forkedAgent.id)).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it('throws FINALIZE_FAILED when the fork subagent produces no output (JSON 超限报错，不降级)', async () => {
    const { llm, agents, assessor } = harness({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      // seed 仅含 turn 边界（无 assistant/message）→ followup 无回复时无输出可收集。
      getStepSessionEvents: async () => [
        boundaryEvent('turn/start', 0, { turn: 0 }),
        boundaryEvent('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }),
      ],
    });
    // followup 不追加 assistant 回复 → finalAssistantOutput 无输出 → 重试仍无输出 → 超限报错。
    agents.createFollowupHandler = () => undefined;

    await expect(assessor.assessForked({
      step: step({ command: { type: 'agent', value: { promptText: 'x' } } }),
      stepSessionId: 'child-1',
      context: { input: 'req', output: 'out' },
    })).rejects.toMatchObject({ code: 'FINALIZE_FAILED', message: expect.stringContaining('JSON parse failed') });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('GateEvaluator', () => {
  // ── primary 门禁 = 纯代码产物校验（零 AI：不跑 llm.stream、不 fork 会话） ──────

  it('passes the primary gate with pure artifact verification (zero AI calls)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out', artifacts: ['/work/out/report.md'] },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(llm.calls).toHaveLength(0);
  });

  it('fails the primary gate when an outputTo file is missing (pure code check, zero AI calls)', async () => {
    const { llm, gateEvaluator } = harness();

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('missing');
    expect(llm.calls).toHaveLength(0);
  });

  it('does not create a subagent when only the primary (code) gate runs', async () => {
    const { llm, fs, sessions, agents, gateEvaluator } = harness();
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      stepSessionId: 'step-session-1',
    });

    // primary 纯代码校验不跑 AI → 不 fork、不建子代理（gateSessionId 为临时句柄占位）。
    expect(sessions.forkedSources).toHaveLength(0);
    expect(agents.createSeeds).toHaveLength(0);
    expect(result.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  // ── secondary 门禁 = AI 门禁审查（显式 enabled:true 才跑；唯一门禁 AI 通道） ──

  it('creates a host continuable subagent for the secondary gate via startContinuable（prompt 携带门禁提示词 + parent=宿主主代理；whenIdle 后取输出）', async () => {
    const { llm, fs, agents, subagents, gateEvaluator } = harness();
    subagents.outputHandler = () => [{ type: 'text', text: '{"gateStatus":"done"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out', artifacts: ['/work/out/report.md'] },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
      stepSessionId: 'step-session-1',
    });

    // secondary 经 startContinuable 建宿主可续接子代理：provider 缺省 'fork'、label 带
    // step id、parent=宿主主代理（Agent 对象）、agentOptions 承载模型路由。
    expect(subagents.starts).toHaveLength(1);
    const spec = subagents.starts[0]!;
    expect(spec.provider).toBe('fork');
    expect(spec.label).toBe('gate step-a');
    expect(spec.request.parent.id).toBe('host-1');
    expect(spec.request.agentOptions).toEqual({ provider: 'p', model: 'm' });
    // prompt 携带 secondary 门禁提示词（原样注入用户 prompt）。
    const promptText = (spec.request.prompt[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(promptText).toContain('review');
    // gateSessionId = startContinuable 返回的真实 childId（UI 可打开）。
    expect(result.gateSessionId).toBe('child-1');
    // 输出收集：child.session.events 的 assistant 消息 → whenIdle → finalAssistantOutput →
    // textSummary → parseSecondaryGate。
    const gateAgent = agents.get('child-1')!;
    expect(gateAgent.whenIdleCount).toBe(1);
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    // 子代理路径不消费 llm.stream（agent loop 内模型调用由子代理自行处理）。
    expect(llm.calls).toHaveLength(0);
  });

  it('follows up the same gate subagent with a reason-carrying correction hint on unparseable output, then succeeds', async () => {
    const { llm, fs, agents, subagents, gateEvaluator } = harness();
    let call = 0;
    subagents.outputHandler = () => {
      call += 1;
      return call === 1 ? [{ type: 'text', text: 'not json at all' }] : undefined;
    };
    subagents.followupHandler = () => [{ type: 'text', text: '{"gateStatus":"done","gateDetail":"ok"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out', artifacts: ['/work/out/report.md'] },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
      stepSessionId: 'step-session-1',
    });

    // 解析失败 → 同一个门禁子代理 followup 纠正（带失败原因）→ 第二次合法 done。
    expect(subagents.followups).toHaveLength(1);
    const hintText = (subagents.followups[0]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(hintText).toContain('不是合法 JSON');
    expect(hintText).toContain('"gateStatus": "done"');
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('explains secondary gate parse failures with concrete reasons', () => {
    expect(explainSecondaryGateParse('{"gateStatus": "done"}')).toBeUndefined();
    expect(explainSecondaryGateParse('{"gateStatus": "error"}')).toBeUndefined();
    expect(explainSecondaryGateParse('not json')).toContain('不是合法 JSON');
    expect(explainSecondaryGateParse('{"gateDetail": "x"}')).toContain('缺少 gateStatus');
    expect(explainSecondaryGateParse('{"gateStatus": "yes"}')).toContain('必须是 done 或 error');
  });

  it('buildSecondaryGateCorrectionHint carries the concrete parse failure reason', () => {
    const hint = buildSecondaryGateCorrectionHint('{"gateStatus": "yes"}');
    expect(hint).toContain('必须是 done 或 error');
    expect(hint).toContain('"gateStatus": "done"');
    expect(hint).toContain('"gateStatus": "error"');
    expect(hint).toContain('```json');
  });

  it('degrades to a temp session when the secondary gate startContinuable throws (不失败，记 errorDetail)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness();
    subagents.startError = new Error('gate start boom');
    llm.streamHandler = () => textChunks('{"gateStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out', artifacts: ['/work/out/report.md'] },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
      stepSessionId: 'missing-session',
    });

    // 降级一次性临时会话（runStream）：gateSessionId 为 UUID 句柄、errorDetail 记原因。
    expect(subagents.starts).toHaveLength(0);
    expect(result.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('gate start boom');
    expect(llm.calls[0]?.sessionId).toBeUndefined();
    expect(result.gatesPassed).toBe(true);
  });

  it('degrades to a temp session when hostAgent is not configured (配置缺省 → runStream + errorDetail)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness({ hostAgent: undefined });
    llm.streamHandler = () => textChunks('{"gateStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    // 未注入 hostAgent → 不建子代理、直接降级临时会话（runStream）+ errorDetail。
    expect(subagents.starts).toHaveLength(0);
    expect(result.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.errorDetail).toContain('hostAgent not configured');
    expect(llm.calls).toHaveLength(1);
    expect(result.gatesPassed).toBe(true);
  });

  it('records a secondary gate result when secondary is enabled (AI 走门禁子代理、不消费 llm.stream)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness();
    subagents.outputHandler = () => [{ type: 'text', text: '{"gateStatus":"done"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    // primary 纯代码校验（零 AI）+ secondary 门禁子代理（agent loop 内模型调用）
    // → llm.stream 零调用；startContinuable 恰好 1 次。
    expect(subagents.starts).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
    expect(result.primaryPassed).toBe(true);
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
  });

  it('secondary 提示词框架：原样注入用户 prompt + 返回格式，不内置完成度/质量检查要求', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness();
    const userPrompt = '核对产物是否满足门控要求';
    subagents.outputHandler = () => [{ type: 'text', text: '{"gateStatus":"done"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: userPrompt } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
    const prompt = (subagents.starts[0]?.request.prompt[0] as { type: string; text: string } | undefined)?.text ?? '';
    // 框架只注入身份 + stepContext + 用户 prompt 原样 + 返回 JSON 格式框架。
    expect(prompt).toContain(userPrompt);
    expect(prompt).toContain('"gateStatus"');
    // 不内置「检查完成度/质量」要求——完成度判断完全由用户 prompt 决定。
    expect(prompt).not.toContain('完成度');
    expect(prompt).not.toContain('质量');
    expect(prompt).not.toContain('基本完成');
    expect(prompt).not.toContain('完整门控审查');
    expect(llm.calls).toHaveLength(0);
  });

  it('collects the gate output via injected awaitSubagentSettlement (settle output 优先；stopReason=completed)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness({
      awaitSubagentSettlement: async childId => ({
        childId,
        stopReason: 'completed',
        output: [{ type: 'text', text: '{"gateStatus":"done"}' }],
      }),
    });
    fs.seedFile('/work/out/report.md');
    // child 不预填输出——settle 载荷 output 携带门禁结果（覆盖 finalAssistantOutput 回退）。

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    expect(result.gateSessionId).toBe('child-1');
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(subagents.starts).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
  });

  it('degrades to a temp session when the gate settlement is not completed (error → 进降级，记 errorDetail)', async () => {
    const { llm, fs, gateEvaluator } = harness({
      awaitSubagentSettlement: async childId => ({ childId, stopReason: 'error' }),
    });
    llm.streamHandler = () => textChunks('{"gateStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    // settle stopReason !== 'completed' → awaitGateOutput 抛错 → 降级临时会话。
    expect(result.errorDetail).toContain('settle error');
    expect(llm.calls).toHaveLength(1);
    expect(result.gatesPassed).toBe(true);
  });

  it('omits primary passed flags when primary is explicitly disabled (only secondary runs)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness();
    subagents.outputHandler = () => [{ type: 'text', text: '{"gateStatus":"done"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: false }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
    expect(result.primaryPassed).toBeUndefined();
    expect(result.secondaryPassed).toBe(true);
    expect(result.gateDetails).toMatchObject({
      primary: { enabled: false },
      secondary: { enabled: true, passed: true, prompt: 'review' },
    });
    expect(result.gateDetails?.primary).not.toHaveProperty('passed');
    expect(subagents.starts).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
  });

  // ── 缺陷 5 次要差异：primary 默认 enabled=true（对齐基准 primary?.enabled ?? true） ──
  // 修前 sandore primary 默认 enabled=false（=== true 判定）；用户只配置 secondary、
  // 未配置 primary 时基准 primary 默认执行，sandore 默认不执行 → 行为分歧。修后
  // primary 未配置即视为启用（!== false），与基准对齐。

  it('defaults primary to enabled when only secondary is configured (code check + secondary AI)', async () => {
    const { llm, fs, subagents, gateEvaluator } = harness();
    // 未配置 primary，仅配置 secondary → primary 默认启用（纯代码校验，零 AI），
    // secondary 经 startContinuable 门禁子代理审查（输出 gateStatus:done）。
    subagents.outputHandler = () => [{ type: 'text', text: '{"gateStatus":"done"}' }];
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    // primary 默认启用：primaryPassed 被置位（非 undefined），gateDetails.primary.enabled=true。
    expect(result.primaryPassed).toBe(true);
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.gateDetails).toMatchObject({
      primary: { enabled: true, passed: true },
      secondary: { enabled: true, passed: true, prompt: 'review' },
    });
    expect(subagents.starts).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
  });

  it('defaults primary to enabled when neither primary nor secondary is configured but gates object exists (code-only, zero AI)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // gates: {}（三级合并后存在 gates 对象但 primary/secondary 均未配置）→
    // primary 默认启用执行纯代码校验、secondary 默认禁用不执行 → 零 AI 调用。
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: {},
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.secondaryPassed).toBeUndefined();
    expect(result.gatesPassed).toBe(true);
    expect(result.gateDetails).toMatchObject({
      primary: { enabled: true, passed: true },
      secondary: { enabled: false },
    });
    expect(llm.calls).toHaveLength(0);
  });

  it('verifies outputTo via regex when a regex is configured', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: 'report\\.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('verifies outputTo via a literal (non-glob) path', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: 'out/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('reports the regex in errorDetail when a regex outputTo is missing', async () => {
    const { llm, gateEvaluator } = harness();

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: 'missing\\.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('missing\\.md');
    expect(llm.calls).toHaveLength(0);
  });

  // ── 缺陷 6：非 glob path 精确存在性检查（替代 findFilesByRegex 误用） ──────────

  it('reports missing for a non-glob literal path when the file is absent and no similar files exist', async () => {
    const { llm, gateEvaluator } = harness();

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: 'out/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('out/report.md');
    expect(llm.calls).toHaveLength(0);
  });

  it('passes a non-glob literal path with a ./ prefix when the file exists (no false missing)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: './out/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    // 旧实现用非锚定 RegExp('./out/report.md')：首字符 `.` 为正则元字符，相对路径
    // 'out/report.md' 无前导字符 → 确定性误报缺失（门禁恒失败）。精确存在性检查只
    // 查 join 后的 /work/out/report.md 本身 → 存在即通过。
    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('still reports missing for a non-glob literal path when a nested similar file would falsely match under regex', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // 期望产物 output/result.txt 本身不存在；仅树内存在嵌套同名/相似文件。
    // 旧实现用非锚定 RegExp(output/result.txt) 全树子串匹配会命中
    // dist/output/result.txt（含子串 'output/result.txt'）→ 该报缺失却放行（漏报）。
    // 精确存在性检查只查 /work/output/result.txt 本身 → 不被相似文件误命中 → 报缺失。
    fs.seedFile('/work/dist/output/result.txt');
    fs.seedFile('/work/output/result.txt.bak');
    fs.seedFile('/work/result1txt');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: 'output/result.txt' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('output/result.txt');
    expect(llm.calls).toHaveLength(0);
  });

  it('still resolves glob and regex outputTo branches after the non-glob fix (regression)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/out/report.md');
    fs.seedFile('/work/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({
        outputTo: [
          { id: 'opt-glob', path: 'out/*.md' },
          { id: 'opt-re', regex: 'report\\.md' },
        ],
      }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    // glob 分支仍走 findFilesByGlob（锚定 ^out/[^/]*\.md$）、regex 字段仍走
    // findFilesByRegex（非锚定全树匹配，语义保留）；两者命中即通过。
    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  // ── 缺陷 19：isGlobPattern 全特征检测后，regex 写法入 path 字段不再误判 glob ──
  // 联动缺陷 6（已修复）：非 glob → fileExists 精确存在性检查，不走 findFilesByRegex
  // ——否则 `.*`→`new RegExp('.*')` 匹配一切→门禁恒放行。以下测试确认联动安全。

  it('reports missing for path=.* (no literal file named .*) instead of 恒放行 via findFilesByRegex', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // 播种一个普通产物文件（无点文件）：若缺陷 6 未修复，`.*` 非glob 会落入
    // findFilesByRegex → `new RegExp('.*')` 匹配 report.md → 门禁恒放行（危险）。
    // 缺陷 6 已修复：非glob → fileExists 精确查字面 `.*` → 不存在 → 报 missing。
    fs.seedFile('/work/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-dotstar', path: '.*' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('.*');
    expect(llm.calls).toHaveLength(0);
  });

  it('reports missing for path=[^a]* and does not falsely pass via globToRegex silent match', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // 播种一个修前 globToRegex 会静默误命中的文件：globToRegex('[^a]*')=^\[\^a\][^/]*$
    // 匹配字面 `[^a]` 前缀 → 误命中 `[^a]note.md` → 门禁假放行（静默错误匹配）。
    // 修后：`[^a]*` 命中 `[^` 特征 → 非glob → fileExists 精确查字面 `[^a]*` → 不存在 → 报 missing。
    fs.seedFile('/work/[^a]note.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-negclass', path: '[^a]*' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(false);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('[^a]*');
    expect(llm.calls).toHaveLength(0);
  });

  // ── 缺陷 34：outputTo path/regex 含 ${xxx} 透传变量占位符的解析与延迟 ──────────

  it('passes the gate when a ${xxx} path resolves via vars and the file exists', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/artifacts/my-project/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      vars: { projectName: 'my-project' },
    });

    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('reports missing when a ${xxx} path resolves via vars but the file is absent', async () => {
    const { llm, gateEvaluator } = harness();

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      vars: { projectName: 'my-project' },
    });

    expect(result.gatesPassed).toBe(false);
    // 报缺失的 pattern 是解析后的字面路径（含真实变量值），便于定位。
    expect(result.errorDetail).toContain('artifacts/my-project/report.md');
    expect(llm.calls).toHaveLength(0);
  });

  it('reports missing when vars lack the variable (deferred literal ${xxx} never matches)', async () => {
    const { llm, gateEvaluator } = harness();
    // 修前原实现：${projectName} 原样入 findFilesByRegex → new RegExp('${projectName}')
    // 的 `$` 行尾锚 + 花括号字面量永不匹配 → 确定性报 missing。resolveOutputToVars
    // 缺省 vars={} 时 deferred=true，字面占位路径走 fileExists 不命中 → 同样报 missing。
    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      // 不传 vars（缺省 {}）→ ${projectName} 未解析 → deferred → 字面不命中。
    });

    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('artifacts/${projectName}/report.md');
    expect(llm.calls).toHaveLength(0);
  });

  it('passes the gate when a ${xxx} regex resolves via vars and a file matches', async () => {
    const { llm, fs, gateEvaluator } = harness();
    fs.seedFile('/work/out/my-project.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: '^out/${projectName}\\.md$' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      vars: { projectName: 'my-project' },
    });

    expect(result.gatesPassed).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('FinalizeManager.finalizeStep', () => {
  it('skips finalize with zero AI calls when there are no vars and no gates', async () => {
    const { llm, manager } = harness();

    const outcome = await manager.finalizeStep({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      executedStep: executedStep(),
      context: { input: '', output: '' },
      workdir: '/work',
    });

    expect(outcome).toEqual({ type: 'done' });
    expect(llm.calls).toHaveLength(0);
  });

  // ── 缺陷 5 次要差异：hasEnabledGates 短路（primary 默认 enabled=true 下的跳过语义） ──

  it('skips finalize (zero AI calls) when gates is undefined (three-level all unconfigured)', async () => {
    // mergeGates 三级均未配置 → 返回 undefined → hasEnabledGates(undefined)=false → 跳过。
    // 显式传 undefined gates 锁定「三级全未配置时不跑门禁」语义（修后仍成立）。
    const { llm, manager } = harness();

    const outcome = await manager.finalizeStep({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      executedStep: executedStep(),
      context: { input: '', output: '' },
      workdir: '/work',
      gates: undefined,
    });

    expect(outcome).toEqual({ type: 'done' });
    expect(llm.calls).toHaveLength(0);
  });

  it('skips finalize (zero AI calls) when both primary and secondary are explicitly disabled', async () => {
    // gates 对象存在但 primary.enabled=false 且 secondary.enabled=false →
    // hasEnabledGates：primary?.enabled !== false → false；secondary?.enabled === true → false
    // → 短路返回 false → 跳过门禁（零 AI 调用）。锁定 !== false 语义下显式禁用仍跳过。
    const { llm, manager } = harness();

    const outcome = await manager.finalizeStep({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      executedStep: executedStep(),
      context: { input: '', output: '' },
      workdir: '/work',
      gates: { primary: { enabled: false }, secondary: { enabled: false } },
    });

    expect(outcome).toEqual({ type: 'done' });
    expect(llm.calls).toHaveLength(0);
  });

  it('marks the step interacting and skips the gate when assess returns ask', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
    });

    expect(outcome.type).toBe('ask');
    expect(executed.status).toBe('interacting');
    expect(llm.calls).toHaveLength(1);
  });

  // ── 假 ask 防御：ask 判定但无 askQuestion 载荷 → 回落 completed（不置 interacting） ──
  // 修前 hasAsk=true 但 askQuestion===undefined 时仍置 status:'ask' →
  // findAskStep 未命中 → 实例永久卡 interacting、UI 无选择框。

  it('treats ask without askQuestion payload as completed instead of fake ask', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":true,"passThroughVars":{}}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    });

    expect(outcome.type).toBe('done');
    expect(executed.status).toBe('completed');
    expect(executed.finalizeMeta?.currentPhase).toBe('completed');
    expect(executed.finalizeMeta?.assessResult?.passThroughVars).toEqual({});
  });

  it('treats a fenced ask-without-question output as completed too (fence + fake-ask combined)', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('```json\n{"hasAsk":true,"passThroughVars":{}}\n```');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    });

    expect(outcome.type).toBe('done');
    expect(executed.status).toBe('completed');
    expect(executed.finalizeMeta?.currentPhase).toBe('completed');
  });

  it('writes back extracted passThroughVars preserving the refresh flag', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{"projectName":"sandore"},"compressedOutput":"摘要"}');
    const passThroughVars: Record<string, PassThroughVarValue> = {};

    await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project', refresh: true }],
      }),
      executedStep: executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    });

    expect(passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project', refresh: true });
  });

  it('records a complete finalizeMeta with currentPhase/assessSessionId/assessResult/gateResult', async () => {
    const { llm, fs, manager } = harness();
    // primary 纯代码校验（零 AI）：只有 assess 一次 LLM 调用（无门禁 AI）。
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
    fs.seedFile('/work/out/report.md');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
        outputTo: [{ id: 'opt-a', path: 'out/*.md' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
    });

    expect(outcome.type).toBe('done');
    expect(executed.finalizeMeta?.currentPhase).toBe('completed');
    expect(executed.finalizeMeta?.assessResult).toBeDefined();
    // Round 17：顶层 assessSessionId 已删除，sessionId 从 assessResult.forkSessionId 内读
    expect(executed.finalizeMeta?.assessResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(executed.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    // Phase C 仅 primary 纯代码校验（无 secondary AI）→ 不建子代理，
    // gateSessionId 为临时句柄占位（schema 强约束）。
    expect(executed.finalizeMeta?.gateResult?.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Phase A（临时会话）+ Phase B（降级临时会话）= 2 次 LLM 调用。
    expect(llm.calls).toHaveLength(2);
  });

  it('returns error with missing-file detail when the gate fails on outputTo', async () => {
    const { llm, manager } = harness();
    // primary 纯代码校验（零 AI）：只有 assess 一次 LLM 调用；门禁报 missing 走代码校验。
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{},"compressedOutput":"摘要"}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
        outputTo: [{ id: 'opt-a', path: 'out/*.md' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
    });

    expect(outcome).toMatchObject({
      type: 'error',
      errorDetail: expect.stringContaining('missing'),
    });
  });

  it('does not write back extracted vars that are not declared on the step', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('{"completionType":"completed","passThroughVars":{"undeclared":"x","projectName":"sandore"},"compressedOutput":"摘要"}');
    const passThroughVars: Record<string, PassThroughVarValue> = {};

    await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    });

    expect(passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
    expect(passThroughVars['undeclared']).toBeUndefined();
  });

  // ── 缺陷 34：自引用变量在门禁时解析（vars = 累加器 + 当次 assess 提取值合并） ──

  it('resolves a self-referential ${xxx} outputTo at gate time using merged vars (file exists → done)', async () => {
    // 场景：Step 声明 projectName（值 ${projectName} 占位）并在自身 outputTo 引用它。
    // assess 提取 projectName=my-project → 合并进 vars → 门禁 verifyArtifacts 解析
    // artifacts/${projectName}/report.md → artifacts/my-project/report.md 命中文件 → 通过。
    // primary 纯代码校验（零 AI）：只有 assess 一次 LLM 调用。
    const { llm, fs, manager } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{"projectName":"my-project"},"compressedOutput":"摘要"}');
    fs.seedFile('/work/artifacts/my-project/report.md');
    const passThroughVars: Record<string, PassThroughVarValue> = {
      projectName: { value: '${projectName}', description: 'project' },
    };

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
        outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }],
      }),
      executedStep: executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
      passThroughVars,
    });

    expect(outcome.type).toBe('done');
    expect(outcome.gateResult?.gatesPassed).toBe(true);
    // 回写后累加器值已更新（persistFinalize 写回 extracted 值）。
    expect(passThroughVars['projectName']).toEqual({ value: 'my-project', description: 'project' });
    // Phase A（临时会话）+ Phase B（降级临时会话）= 2 次 LLM 调用。
    expect(llm.calls).toHaveLength(2);
  });

  it('reports missing at gate time when a self-referential ${xxx} outputTo resolves but the file is absent', async () => {
    // 同上，但文件缺失 → verifyArtifacts 解析后命中字面 artifacts/my-project/report.md
    // 不存在 → 报 missing → gatesPassed=false → outcome.type=error。
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{"projectName":"my-project"},"compressedOutput":"摘要"}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
        outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
    });

    expect(outcome).toMatchObject({
      type: 'error',
      errorDetail: expect.stringContaining('artifacts/my-project/report.md'),
    });
  });
});

describe('FinalizeManager 3 阶段拆分（assessOnly / evaluateGates / commitFinalize，5 阶段收尾）', () => {
  it('assessOnly 只跑评估并返回 hasAsk（不跑门禁、不回写 finalizeMeta）', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const assessResult = await manager.assessOnly({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    });

    expect(assessResult.hasAsk).toBe(false);
    expect(assessResult.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(llm.calls).toHaveLength(1);
    // Phase A 不回写任何状态。
    expect(executed.finalizeMeta).toBeUndefined();
  });

  it('assessOnly 假 ask 防御：hasAsk 但无 askQuestion 载荷回落 hasAsk=false', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":true,"passThroughVars":{}}');

    const assessResult = await manager.assessOnly({
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    });

    expect(assessResult.hasAsk).toBe(false);
  });

  it('evaluateGates 只跑门禁（primary 纯代码校验，零 AI）并返回 gateResult（不回写状态）', async () => {
    const { llm, fs, manager } = harness();
    fs.seedFile('/work/out/report.md');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const assessResult: FinalizeAssessResult = {
      hasAsk: false,
      passThroughVars: {},
      forkSessionId: 'session-1',
      assessmentRaw: '',
    };
    const gateResult = await manager.evaluateGates({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        outputTo: [{ id: 'opt-a', path: 'out/*.md' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      gates: { primary: { enabled: true } },
    }, assessResult);

    // primary 纯代码校验：产物存在 → 通过；无 secondary → 零 AI、不 fork 门禁会话。
    expect(gateResult.gatesPassed).toBe(true);
    expect(gateResult.primaryPassed).toBe(true);
    expect(gateResult.gateSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(llm.calls).toHaveLength(0);
    expect(executed.finalizeMeta).toBeUndefined();
  });

  it('commitFinalize 组装 finalizeMeta（currentPhase + assessSessionId/gateSessionId）并回写透传变量', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
    const passThroughVars: Record<string, PassThroughVarValue> = {};
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    const assessResult = await manager.assessOnly({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    });

    await manager.commitFinalize({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    }, assessResult, undefined, 'finalizing');

    // Phase B 收尾：透传变量已回写（保留 refresh）。
    expect(passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
    // finalizeMeta：currentPhase='finalizing'；Round 17 顶层 assessSessionId 已删除，
    // sessionId 从 assessResult.forkSessionId 内读。
    expect(executed.finalizeMeta?.currentPhase).toBe('finalizing');
    expect(executed.finalizeMeta?.assessResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(executed.finalizeMeta?.assessResult?.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(executed.finalizeMeta?.gateResult).toBeUndefined();
  });

  it('commitFinalize 触发 onPhaseChange 回调（step + childId + phase 透传，供引擎双发 sandore/step-phase）', async () => {
    const { manager } = harness();
    const phases: Array<{ stepId: string; childId: string | undefined; phase: string }> = [];
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    // 收尾阶段事件 childId 取执行段 sessionMeta.childId（真实子代理或合成占位）。
    executed.sessionMeta = { childId: 'child-1', synthetic: false, command: 'prompt' };

    await manager.commitFinalize({
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      onPhaseChange: (step, childId, phase) => phases.push({ stepId: step.id, childId, phase }),
    }, undefined, undefined, 'completed');

    expect(phases).toEqual([{ stepId: 'step-a', childId: 'child-1', phase: 'completed' }]);
    // 回调在 finalizeMeta 写入后触发（阶段已落盘）。
    expect(executed.finalizeMeta?.currentPhase).toBe('completed');
  });

  it('Phase A ask 保底中断的 finalizeMeta 不记录顶层 assessSessionId（Phase A 临时会话不持久化，4.6/4.1）', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"确认继续？"}]}}');
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });

    const outcome = await manager.finalizeStep({
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    });

    expect(outcome.type).toBe('ask');
    expect(executed.status).toBe('interacting');
    // Phase A 中断快照：currentPhase='ask-detect'；顶层 assessSessionId 不持久化
    // （计划：Phase A 临时会话用完即删、Phase B 收尾才落 assessSessionId）。
    expect(executed.finalizeMeta?.currentPhase).toBe('ask-detect');
    expect(executed.finalizeMeta?.assessSessionId).toBeUndefined();
    // askResult 随快照落 state（findAskStep 依赖 askQuestion；forkSessionId 为 schema 强约束）。
    expect(executed.finalizeMeta?.askResult?.hasAsk).toBe(true);
    expect(executed.finalizeMeta?.askResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(executed.finalizeMeta?.assessResult).toBeUndefined();
  });

  // ── commitFinalize 透传变量写回门控：仅在 Phase B（'finalizing'）执行 ──────────

  it('commitFinalize 透传变量写回仅发生在 Phase B（finalizing）——Phase A（ask-detect）不写回', async () => {
    const { manager } = harness();
    const passThroughVars: Record<string, PassThroughVarValue> = {};
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    const request = {
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    };
    const assessResult: FinalizeAssessResult = {
      hasAsk: true,
      passThroughVars: { projectName: 'sandore' },
      forkSessionId: 'eval-1234abcd',
      assessmentRaw: '{"hasAsk":true,"passThroughVars":{"projectName":"sandore"}}',
    };

    // Phase A（ask-detect）调用：finalizeMeta 落盘但不回写透传变量。
    await manager.commitFinalize(request, assessResult, undefined, 'ask-detect', { recordAssessSession: false });
    expect(passThroughVars['projectName']).toBeUndefined();
    expect(executed.finalizeMeta?.currentPhase).toBe('ask-detect');

    // Phase B（finalizing）调用：透传变量回写。
    await manager.commitFinalize(request, assessResult, undefined, 'finalizing');
    expect(passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
    expect(executed.finalizeMeta?.currentPhase).toBe('finalizing');
  });

  it('commitFinalize gating/completed 终态不再重复回写透传变量（Phase B 已写，幂等重写不覆盖累加器）', async () => {
    const { manager } = harness();
    const passThroughVars: Record<string, PassThroughVarValue> = {
      projectName: { value: 'sandore', description: 'project' },
    };
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    const request = {
      step: step({
        command: { type: 'prompt', value: { promptText: 'x' } },
        passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
      }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      passThroughVars,
    };
    const assessResult: FinalizeAssessResult = {
      hasAsk: false,
      passThroughVars: {},
      forkSessionId: 'eval-1234abcd',
      assessmentRaw: '{"hasAsk":false,"passThroughVars":{}}',
    };

    // gating/completed 终态提交不触发写回（写回仅 finalizing；避免终态覆盖已落账值）。
    await manager.commitFinalize(request, assessResult, undefined, 'gating');
    await manager.commitFinalize(request, assessResult, undefined, 'completed');
    expect(passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
  });

  // ── Bug 1：commitFinalize previousPhase 记录阶段流转痕迹 ──────────

  it('commitFinalize records previousPhase when currentPhase changes (routing 时 previousPhase=finalizing)', async () => {
    const { manager } = harness();
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    const request = {
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
    };
    const assessResult: FinalizeAssessResult = {
      hasAsk: false,
      passThroughVars: {},
      forkSessionId: 'eval-1234abcd',
      assessmentRaw: '',
    };

    // Phase B（finalizing）：首次写入，无 previousPhase。
    await manager.commitFinalize(request, assessResult, undefined, 'finalizing');
    expect(executed.finalizeMeta?.currentPhase).toBe('finalizing');
    expect(executed.finalizeMeta?.previousPhase).toBeUndefined();

    // Phase D（routing）：previousPhase = 'finalizing'。
    await manager.commitFinalize(request, assessResult, undefined, 'routing');
    expect(executed.finalizeMeta?.currentPhase).toBe('routing');
    expect(executed.finalizeMeta?.previousPhase).toBe('finalizing');

    // completed：previousPhase = 'routing'。
    await manager.commitFinalize(request, assessResult, undefined, 'completed');
    expect(executed.finalizeMeta?.currentPhase).toBe('completed');
    expect(executed.finalizeMeta?.previousPhase).toBe('routing');
  });

  // ── Round 7：commitFinalize onPersist/onPhaseChange 执行顺序 + 中间态同步 ──

  it('commitFinalize executes onPersist before onPhaseChange (Round 7 顺序保证)', async () => {
    const { manager } = harness();
    const callOrder: string[] = [];
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    executed.sessionMeta = { childId: 'child-1', synthetic: false, command: 'prompt' };

    await manager.commitFinalize({
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      onPersist: async () => { callOrder.push('onPersist'); },
      onPhaseChange: () => { callOrder.push('onPhaseChange'); },
    }, undefined, undefined, 'finalizing');

    expect(callOrder).toEqual(['onPersist', 'onPhaseChange']);
  });

  it('commitFinalize onPersist receives executedStep with updated finalizeMeta (Round 7 中间态同步)', async () => {
    const { manager } = harness();
    let persistedStep: ExecutedStepDefault | undefined;
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    executed.sessionMeta = { childId: 'child-1', synthetic: false, command: 'prompt' };

    await manager.commitFinalize({
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      onPersist: async (step) => { persistedStep = step; },
    }, undefined, undefined, 'finalizing');

    expect(persistedStep).toBeDefined();
    expect(persistedStep?.finalizeMeta?.currentPhase).toBe('finalizing');
  });

  it('commitFinalize onPhaseChange sees finalizeMeta already synced via onPersist (Round 7 事件前中间态就绪)', async () => {
    const { manager } = harness();
    let phaseAtEventTime: string | undefined;
    const executed = executedStep({ command: { type: 'prompt', value: { promptText: 'x' } } });
    executed.sessionMeta = { childId: 'child-1', synthetic: false, command: 'prompt' };

    // 模拟引擎侧 onPersist：将 executedStep upsert 进 active.state（此处用同步回调模拟）。
    let activeStateSynced = false;
    await manager.commitFinalize({
      step: step({ command: { type: 'prompt', value: { promptText: 'x' } } }),
      executedStep: executed,
      stepSessionId: 's1',
      context: { input: 'req', output: 'out' },
      workdir: '/work',
      onPersist: async () => { activeStateSynced = true; },
      onPhaseChange: () => { phaseAtEventTime = activeStateSynced ? 'synced' : 'not-synced'; },
    }, undefined, undefined, 'gating');

    expect(phaseAtEventTime).toBe('synced');
    expect(executed.finalizeMeta?.currentPhase).toBe('gating');
  });
});
