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
import type { ExecutedStepDefault } from '../../workflow/src/types.ts';
import type { WorkflowStep } from '../../workflow/src/schema.ts';

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

  it('degrades to a temp session when fork throws and does not fail the assess', async () => {
    const { llm, sessions, assessor } = harness();
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');
    sessions.forkHandler = () => {
      throw new Error('SESSION_NOT_FOUND');
    };

    const result = await assessor.assess({
      step: step({ command: { type: 'prompt', value: { promptText: 'do work' } } }),
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

  it('omits primary passed flags when only secondary is enabled', async () => {
    const { llm, fs, gateEvaluator } = harness();
    llm.streamHandler = () => textChunks('{"gateStatus":"done"}');
    fs.seedFile('/work/out/report.md');

    const result = await gateEvaluator.evaluate({
      step: step({ outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }),
      context: { input: 'req', output: 'out' },
      gates: { secondary: { enabled: true, prompt: 'review' } },
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
});
