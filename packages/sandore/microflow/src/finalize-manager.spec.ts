/**
 * finalize-manager.ts（FinalizeAssessor + GateEvaluator + FinalizeManager）的单元测试。
 *
 * 覆盖解析纯函数（parseAssessResult 三级回退 / parsePrimaryGate / parseSecondaryGate）、
 * FinalizeAssessor（session 类型 fork 会话 / fork 抛错降级 / shell 临时会话 / ask 载荷）、
 * GateEvaluator（primary 门禁 + 产物存在性覆盖）与 finalizeStep 编排（跳过 / ask 中断门禁 /
 * 完整 finalize 的 finalizeMeta 回写 / 透传变量回写保留 refresh）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/finalize-manager.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FinalizeAssessor, FinalizeManager, GateEvaluator, parseAssessResult, parsePrimaryGate, parseSecondaryGate } from './finalize-manager.ts';
import type { FinalizeManagerConfig } from './finalize-manager.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome } from './file-utils.ts';
import type { PassThroughVarValue } from './stage-executor.ts';
import type { ExecutedStepDefault } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { WorkflowStep } from '@deepseek-ai/dsh-sandore-workflow/src/schema';

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

/** 组装 finalize-manager 测试环境（注入 mock llm/sessions/fs 与固定引擎默认 provider/model）。 */
function harness(): {
  ctx: Context;
  llm: FakeLlm;
  sessions: FakeSessionStore;
  fs: FakeFs;
  assessor: FinalizeAssessor;
  gateEvaluator: GateEvaluator;
  manager: FinalizeManager;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const sessions = new FakeSessionStore();
  const fs = new FakeFs();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('fs', fs as unknown as FileSystem);
  const config: FinalizeManagerConfig = { defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' };
  return {
    ctx,
    llm,
    sessions,
    fs,
    assessor: new FinalizeAssessor(ctx, config),
    gateEvaluator: new GateEvaluator(ctx, config),
    manager: new FinalizeManager(ctx, config),
  };
}

describe('parseAssessResult', () => {
  it('extracts completionType, passThroughVars and askQuestion from JSON', () => {
    const result = parseAssessResult(
      '{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}',
    );
    expect(result.completionType).toBe('completed');
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.askQuestion).toBeUndefined();
  });

  it('preserves askQuestion id/question/options fields when completionType is ask', () => {
    const result = parseAssessResult(
      '{"completionType":"ask","passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}',
    );
    expect(result.completionType).toBe('ask');
    expect(result.askQuestion?.questions[0]).toMatchObject({ id: 'q1', question: '选择分支' });
    expect(result.askQuestion?.questions[0]?.options).toEqual([{ label: 'A' }]);
  });

  it('falls back to regex completionType when JSON is wrapped in prose', () => {
    const result = parseAssessResult('结果如下：\n{"completionType": "ask"}\n请查收');
    expect(result.completionType).toBe('ask');
    expect(result.passThroughVars).toEqual({});
  });

  it('falls back to completed with empty vars for plain output', () => {
    const result = parseAssessResult('  plain text  ');
    expect(result.completionType).toBe('completed');
    expect(result.passThroughVars).toEqual({});
  });

  it('preserves askQuestion header/option description/multi_select fields', () => {
    const result = parseAssessResult(
      '{"completionType":"ask","passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择","header":"请选择","options":[{"label":"A","description":"方案A"},{"label":"B"}],"multi_select":true}]}}',
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
  // 修前裸 JSON.parse 失败 → regex 回退只恢复 completionType='ask'、askQuestion 丢失
  // → 假 ask → findAskStep 未命中 → 实例永久卡 interacting。修后围栏剥离再解析。

  it('parses askQuestion and passThroughVars from a ```json-fenced output', () => {
    const result = parseAssessResult(
      '```json\n{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}\n```',
    );
    expect(result.completionType).toBe('ask');
    expect(result.passThroughVars).toEqual({ projectName: 'sandore' });
    expect(result.askQuestion?.questions[0]).toMatchObject({ id: 'q1', question: '选择分支' });
    expect(result.askQuestion?.questions[0]?.options).toEqual([{ label: 'A' }]);
  });

  it('parses a fenced JSON block wrapped in surrounding prose', () => {
    const result = parseAssessResult(
      '收尾评估结果：\n```json\n{"completionType":"completed","passThroughVars":{"a":"b"}}\n```\n请查收',
    );
    expect(result.completionType).toBe('completed');
    expect(result.passThroughVars).toEqual({ a: 'b' });
  });

  it('tolerates an uppercase fence language tag', () => {
    const result = parseAssessResult(
      '```JSON\n{"completionType":"ask","passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"Q"}]}}\n```',
    );
    expect(result.completionType).toBe('ask');
    expect(result.askQuestion?.questions[0]?.id).toBe('q1');
  });

  it('falls back to completed when the fenced block contains invalid JSON', () => {
    const result = parseAssessResult('```json\n{not valid json}\n```');
    expect(result.completionType).toBe('completed');
    expect(result.passThroughVars).toEqual({});
    expect(result.askQuestion).toBeUndefined();
  });

  it('keeps regex fallback behavior for unfenced prose without valid JSON', () => {
    const result = parseAssessResult('结果如下：\n这里没有 JSON\n请查收');
    expect(result.completionType).toBe('completed');
    expect(result.passThroughVars).toEqual({});
  });
});

describe('parsePrimaryGate / parseSecondaryGate', () => {
  it('parses taskStatus done as passed for the primary gate', () => {
    expect(parsePrimaryGate('{"taskStatus":"done"}').passed).toBe(true);
  });

  it('parses taskStatus error with errorDetail for the primary gate', () => {
    const result = parsePrimaryGate('{"taskStatus":"error","errorDetail":"missing artifacts"}');
    expect(result.passed).toBe(false);
    expect(result.errorDetail).toBe('missing artifacts');
  });

  it('parses gateStatus done as passed for the secondary gate', () => {
    expect(parseSecondaryGate('{"gateStatus":"done"}').passed).toBe(true);
    expect(parseSecondaryGate('{"gateStatus":"error","gateDetail":"needs review"}')).toEqual({
      passed: false,
      detail: 'needs review',
    });
  });

  it('parses fenced outputs for both gates (fence stripping is shared)', () => {
    expect(parsePrimaryGate('```json\n{"taskStatus":"error","errorDetail":"missing"}\n```')).toEqual({
      passed: false,
      errorDetail: 'missing',
    });
    expect(parseSecondaryGate('```json\n{"gateStatus":"done"}\n```').passed).toBe(true);
  });
});

describe('FinalizeAssessor', () => {
  it('forks the step session for a session-type step and records forkSessionId', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'out', artifacts: ['a.md'] },
    });

    expect(sessions.forkedSources).toEqual(['step-session-1']);
    expect(result.forkSessionId).toBe('session-1');
    expect(result.completionType).toBe('completed');
  });

  it('forks the step session for a prompt-type step (决策 D3: prompt 为真实子代理会话)', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'prompt', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'out' },
    });

    // prompt 与 agent/skill/mcp 同为 session 类型：走 sessions.fork 评估续接（不再降级）。
    expect(sessions.forkedSources).toEqual(['step-session-1']);
    expect(result.forkSessionId).toBe('session-1');
    expect(result.completionType).toBe('completed');
  });

  it('degrades to a temp session when fork throws and does not fail the assess', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');
    sessions.forkHandler = () => {
      throw new Error('SESSION_NOT_FOUND');
    };

    const result = await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'missing-session',
      context: { input: 'req', output: 'out' },
    });

    expect(result.forkSessionId).toMatch(/^eval-/);
    expect(result.errorDetail).toContain('SESSION_NOT_FOUND');
    expect(result.completionType).toBe('completed');
    expect(llm.calls[0]?.sessionId).toBeUndefined();
  });

  it('uses a temp session (no fork) for a shell-type step', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'shell', value: { command: 'echo hi' } } }),
      context: { input: '', output: 'stdout', artifacts: [] },
    });

    expect(sessions.forkedSources).toHaveLength(0);
    expect(result.forkSessionId).toMatch(/^eval-/);
    expect(llm.calls[0]?.sessionId).toBeUndefined();
  });

  it('stamps the fork session id onto the assess LLM request', async () => {
    const { llm, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');

    const result = await assessor.assess({
      step: step({ command: { type: 'agent', value: { promptText: 'do work' } } }),
      stepSessionId: 'step-session-1',
      context: { input: 'req', output: 'out' },
    });

    expect(result.forkSessionId).toBe('session-1');
    expect(llm.calls[0]?.sessionId).toBe('session-1');
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
});

describe('GateEvaluator', () => {
  it('passes the primary gate when the AI reports done and artifacts exist', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out', artifacts: ['/work/out/report.md'] },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
    expect(result.gateSessionId).toMatch(/^eval-/);
  });

  it('overrides gatesPassed to false when the AI passes but an outputTo file is missing', async () => {
    const { llm, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('missing');
  });

  it('records a secondary gate result when secondary is enabled', async () => {
    const { llm, fs, gateEvaluator } = harness();
    let call = 0;
    llm.streamHandler = () => {
      const text = call === 0 ? '{"taskStatus":"done"}' : '{"gateStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true }, secondary: { enabled: true, prompt: 'review' } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.secondaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(true);
  });

  it('omits primary passed flags when primary is explicitly disabled (only secondary runs)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"gateStatus":"done"}');
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
  });

  // ── 缺陷 5 次要差异：primary 默认 enabled=true（对齐基准 primary?.enabled ?? true） ──
  // 修前 sandore primary 默认 enabled=false（=== true 判定）；用户只配置 secondary、
  // 未配置 primary 时基准 primary 默认执行，sandore 默认不执行 → 行为分歧。修后
  // primary 未配置即视为启用（!== false），与基准对齐。

  it('defaults primary to enabled when only secondary is configured (aligns with baseline primary?.enabled ?? true)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // 未配置 primary，仅配置 secondary → primary 默认启用，双门禁均执行。
    // call 0 = primary（返回 taskStatus:done），call 1 = secondary（返回 gateStatus:done）。
    let call = 0;
    llm.streamHandler = () => {
      const text = call === 0 ? '{"taskStatus":"done"}' : '{"gateStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
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
    expect(call).toBe(2);
  });

  it('defaults primary to enabled when neither primary nor secondary is configured but gates object exists', async () => {
    const { llm, fs, gateEvaluator } = harness();
    // gates: {}（三级合并后存在 gates 对象但 primary/secondary 均未配置）→
    // primary 默认启用执行、secondary 默认禁用不执行。对齐基准：任一级配了 gates
    // 对象即 primary 默认 enabled=true、secondary 默认 false。
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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
    expect(llm.calls).toHaveLength(1);
  });

  it('verifies outputTo via regex when a regex is configured', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
    fs.seedFile('/work/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: 'report\\.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
  });

  it('verifies outputTo via a literal (non-glob) path', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: 'out/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(true);
  });

  it('reports the regex in errorDetail when a regex outputTo is missing', async () => {
    const { llm, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: 'missing\\.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('missing\\.md');
  });

  // ── 缺陷 6：非 glob path 精确存在性检查（替代 findFilesByRegex 误用） ──────────

  it('reports missing for a non-glob literal path when the file is absent and no similar files exist', async () => {
    const { llm, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-p', path: 'out/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
    });

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('out/report.md');
  });

  it('passes a non-glob literal path with a ./ prefix when the file exists (no false missing)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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
  });

  it('still reports missing for a non-glob literal path when a nested similar file would falsely match under regex', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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
  });

  it('still resolves glob and regex outputTo branches after the non-glob fix (regression)', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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
  });

  // ── 缺陷 19：isGlobPattern 全特征检测后，regex 写法入 path 字段不再误判 glob ──
  // 联动缺陷 6（已修复）：非 glob → fileExists 精确存在性检查，不走 findFilesByRegex
  // ——否则 `.*`→`new RegExp('.*')` 匹配一切→门禁恒放行。以下测试确认联动安全。

  it('reports missing for path=.* (no literal file named .*) instead of 恒放行 via findFilesByRegex', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('.*');
  });

  it('reports missing for path=[^a]* and does not falsely pass via globToRegex silent match', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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

    expect(result.primaryPassed).toBe(true);
    expect(result.gatesPassed).toBe(false);
    expect(result.errorDetail).toContain('[^a]*');
  });

  // ── 缺陷 34：outputTo path/regex 含 ${xxx} 透传变量占位符的解析与延迟 ──────────

  it('passes the gate when a ${xxx} path resolves via vars and the file exists', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
    fs.seedFile('/work/artifacts/my-project/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      vars: { projectName: 'my-project' },
    });

    expect(result.gatesPassed).toBe(true);
  });

  it('reports missing when a ${xxx} path resolves via vars but the file is absent', async () => {
    const { llm, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');

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
  });

  it('reports missing when vars lack the variable (deferred literal ${xxx} never matches)', async () => {
    const { llm, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
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
  });

  it('passes the gate when a ${xxx} regex resolves via vars and a file matches', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"taskStatus":"done"}');
    fs.seedFile('/work/out/my-project.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-re', regex: '^out/${projectName}\\.md$' }] }),
      context: { input: 'req', output: 'out' },
      gates: { primary: { enabled: true } },
      workdir: '/work',
      vars: { projectName: 'my-project' },
    });

    expect(result.gatesPassed).toBe(true);
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

    expect(outcome).toEqual({ type: 'done', completionType: 'completed' });
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

    expect(outcome).toEqual({ type: 'done', completionType: 'completed' });
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

    expect(outcome).toEqual({ type: 'done', completionType: 'completed' });
    expect(llm.calls).toHaveLength(0);
  });

  it('marks the step interacting and skips the gate when assess returns ask', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('{"completionType":"ask","passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"选择分支","options":[{"label":"A"}]}]}}');
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
  // 修前 completionType='ask' 但 askQuestion===undefined 时仍置 status:'ask' →
  // findAskStep 未命中 → 实例永久卡 interacting、UI 无选择框。

  it('treats ask without askQuestion payload as completed instead of fake ask', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"ask","passThroughVars":{}}');
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
    expect(executed.finalizeMeta?.status).toBe('completed');
    expect(executed.finalizeMeta?.completionType).toBe('completed');
  });

  it('treats a fenced ask-without-question output as completed too (fence + fake-ask combined)', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () =>
      textChunks('```json\n{"completionType":"ask","passThroughVars":{}}\n```');
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
    expect(executed.finalizeMeta?.status).toBe('completed');
  });

  it('writes back extracted passThroughVars preserving the refresh flag', async () => {
    const { llm, manager } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}');
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

  it('records a complete finalizeMeta with status/completionType/assessResult/gateResult', async () => {
    const { llm, fs, manager } = harness();
    let call = 0;
    llm.streamHandler = () => {
      const text =
        call === 0
          ? '{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}'
          : '{"taskStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
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
    expect(executed.finalizeMeta?.status).toBe('completed');
    expect(executed.finalizeMeta?.completionType).toBe('completed');
    expect(executed.finalizeMeta?.assessResult).toBeDefined();
    expect(executed.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(executed.finalizeMeta?.gateSessionId).toMatch(/^eval-/);
  });

  it('returns error with missing-file detail when the gate fails on outputTo', async () => {
    const { llm, manager } = harness();
    let call = 0;
    llm.streamHandler = () => {
      const text = call === 0 ? '{"completionType":"completed","passThroughVars":{}}' : '{"taskStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
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
      textChunks('{"completionType":"completed","passThroughVars":{"undeclared":"x","projectName":"sandore"}}');
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
    const { llm, fs, manager } = harness();
    let call = 0;
    llm.streamHandler = () => {
      const text =
        call === 0
          ? '{"completionType":"completed","passThroughVars":{"projectName":"my-project"}}'
          : '{"taskStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
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
  });

  it('reports missing at gate time when a self-referential ${xxx} outputTo resolves but the file is absent', async () => {
    // 同上，但文件缺失 → verifyArtifacts 解析后命中字面 artifacts/my-project/report.md
    // 不存在 → 报 missing → gatesPassed=false → outcome.type=error。
    const { llm, manager } = harness();
    let call = 0;
    llm.streamHandler = () => {
      const text =
        call === 0
          ? '{"completionType":"completed","passThroughVars":{"projectName":"my-project"}}'
          : '{"taskStatus":"done"}';
      call += 1;
      return textChunks(text);
    };
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
