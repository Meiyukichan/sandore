/**
 * branch-evaluator.ts（BranchEvaluator + extractExpectation/extractBreakResult/
 * matchesExpectation）的单元测试。
 *
 * 覆盖两阶段 start/collect/evaluate（agent 临时会话 + shell 直接执行）、shell 三注入
 * （透传替换/env/stdin）、三级 expectation 解析、break 结果解析与分支匹配。
 * @module @deepseek-ai/dsh-sandore-microflow/src/branch-evaluator.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell, successResult } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { BranchEvaluator, extractBreakResult, extractExpectation, matchesExpectation } from './branch-evaluator.ts';
import type { BranchEvaluatorConfig } from './branch-evaluator.ts';

/** 组装 BranchEvaluator 测试环境（注入 mock llm/shell/subprocess）。 */
function harness(config: BranchEvaluatorConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  subprocess: FakeSubprocess;
  evaluator: BranchEvaluator;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subprocess = new FakeSubprocess();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subprocess', subprocess);
  return { ctx, llm, shell, subprocess, evaluator: new BranchEvaluator(ctx, config) };
}

describe('extractExpectation', () => {
  it('extracts branchExpectation from standard JSON', () => {
    expect(extractExpectation('{"branchExpectation": "lint-clean"}')).toBe('lint-clean');
  });

  it('extracts branchExpectation via regex when JSON is mixed with prose', () => {
    expect(extractExpectation('结果如下：\n{"branchExpectation": "build-ok"}\n请查收')).toBe('build-ok');
  });

  it('falls back to the trimmed raw text for plain output', () => {
    expect(extractExpectation('  lint-clean  ')).toBe('lint-clean');
  });
});

describe('extractBreakResult', () => {
  it('returns "true" for JSON with shouldBreak true', () => {
    expect(extractBreakResult('{"shouldBreak": true}')).toBe('true');
  });

  it('returns "false" for JSON with shouldBreak false', () => {
    expect(extractBreakResult('{"shouldBreak": false}')).toBe('false');
  });

  it('returns "true" for a string shouldBreak "true"', () => {
    expect(extractBreakResult('{"shouldBreak": "true"}')).toBe('true');
  });

  it('returns "false" for a string shouldBreak "false"', () => {
    expect(extractBreakResult('{"shouldBreak": "false"}')).toBe('false');
  });

  it('extracts shouldBreak via case-insensitive regex for mixed output', () => {
    expect(extractBreakResult('... {"shouldBreak": TRUE} ...')).toBe('true');
  });

  it('falls back to the trimmed raw text for plain output', () => {
    expect(extractBreakResult('  keep going  ')).toBe('keep going');
  });
});

describe('matchesExpectation', () => {
  it('matches an exact string expectation', () => {
    expect(matchesExpectation('lint-clean', 'lint-clean')).toBe(true);
    expect(matchesExpectation('lint-clean', 'lint-dirty')).toBe(false);
  });

  it('matches a regex expectation', () => {
    expect(matchesExpectation('build-ok', 'build-.*')).toBe(true);
    expect(matchesExpectation('build-fail', 'build-(ok|pass)')).toBe(false);
  });

  it('falls back to false for an invalid regex expectation', () => {
    expect(matchesExpectation('anything', '[')).toBe(false);
  });
});

describe('BranchEvaluator two-phase', () => {
  it('runs an agent condition through a temp session with a non-null sessionHandle', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"branchExpectation": "a"}');

    const partial = await evaluator.start(
      { type: 'agent', value: { promptText: 'check', providerId: 'p', modelId: 'm' } },
      'context',
    );
    expect(partial.sessionHandle).not.toBeNull();
    expect(llm.calls).toHaveLength(1);

    const result = await evaluator.collect(partial);
    expect(result.output).toBe('{"branchExpectation": "a"}');
    expect(result.sessionHandle).toBe(partial.sessionHandle);
  });

  it('evaluates an agent condition in one step via evaluate()', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('{"branchExpectation": "a"}');

    const result = await evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } }, 'ctx');
    expect(result.output).toBe('{"branchExpectation": "a"}');
    expect(result.sessionHandle).not.toBeNull();
  });

  it('executes a shell condition directly with a null sessionHandle', async () => {
    const { shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');

    const result = await evaluator.evaluate(
      { type: 'shell', value: { command: 'echo lint-clean' } },
      'ctx',
    );
    expect(shell.specs).toHaveLength(1);
    expect(result.sessionHandle).toBeNull();
    expect(result.output).toBe('lint-clean');
  });
});

describe('BranchEvaluator shell three-injection', () => {
  it('replaces passThroughVars in the command and injects them into the subprocess env', async () => {
    const { subprocess, evaluator } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await evaluator.evaluate(
      { type: 'shell', value: { command: 'echo ${projectName}' } },
      'ctx',
      { passThroughVars: { projectName: 'sandore' } },
    );

    expect(subprocess.specs).toHaveLength(1);
    expect(subprocess.specs[0]?.argv).toEqual(['/usr/bin/echo', 'sandore']);
    expect(subprocess.specs[0]?.env).toEqual({ projectName: 'sandore' });
  });

  it('writes the stdin content into the subprocess stdio', async () => {
    const { subprocess, evaluator } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await evaluator.evaluate(
      { type: 'shell', value: { command: 'node read-stdin.js' } },
      'ctx',
      { stdin: '{"foo":"bar"}' },
    );

    expect(subprocess.specs[0]?.stdio.stdin).toEqual({ data: '{"foo":"bar"}' });
  });

  it('uses shell.run for a simple shell condition without injection', async () => {
    const { shell, subprocess, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'ok');

    const result = await evaluator.evaluate({ type: 'shell', value: { command: 'echo ok' } }, 'ctx');

    expect(shell.specs).toHaveLength(1);
    expect(subprocess.specs).toHaveLength(0);
    expect(result.output).toBe('ok');
  });
});

describe('BranchEvaluator shell error paths', () => {
  it('throws STEP_EXECUTION with stderr summary on nonzero exit', async () => {
    const { shell, evaluator } = harness();
    shell.runHandler = async spec => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom', truncated: false },
    });

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'false' } }, 'ctx')).rejects.toMatchObject({
      code: 'STEP_EXECUTION',
    });
    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'false' } }, 'ctx')).rejects.toThrow(/boom/);
  });

  it('maps timedOut to STEP_TIMEOUT', async () => {
    const { shell, evaluator } = harness();
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } }, 'ctx')).rejects.toMatchObject({
      code: 'STEP_TIMEOUT',
    });
  });

  it('maps aborted to STEP_EXECUTION', async () => {
    const { shell, evaluator } = harness();
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      aborted: true,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } }, 'ctx')).rejects.toMatchObject({
      code: 'STEP_EXECUTION',
    });
  });

  it('maps a subprocess nonzero exit to STEP_EXECUTION', async () => {
    const { subprocess, evaluator } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 2, signal: null });

    await expect(
      evaluator.evaluate({ type: 'shell', value: { command: 'false' } }, 'ctx', { passThroughVars: { a: '1' } }),
    ).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('maps a subprocess timedOut to STEP_TIMEOUT', async () => {
    const { subprocess, evaluator } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true });

    await expect(
      evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } }, 'ctx', { passThroughVars: { a: '1' } }),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });
});

describe('BranchEvaluator provider/model fallback', () => {
  it('falls back to the directory provider/model at L3', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'dir-p', name: 'Directory Provider' });
    llm.models.set('dir-p', [{ provider: 'dir-p', id: 'dir-m', name: 'Directory Model' }]);
    llm.streamHandler = () => textChunks('{"branchExpectation": "a"}');

    await evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } }, 'ctx');

    expect(llm.calls[0]?.provider).toBe('dir-p');
    expect(llm.calls[0]?.model).toBe('dir-m');
  });

  it('throws STEP_EXECUTION when no LLM provider is available', async () => {
    const { evaluator } = harness();

    await expect(evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } }, 'ctx')).rejects.toThrow(
      /no LLM provider available/,
    );
  });

  it('throws STEP_EXECUTION when a provider has no models', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });

    await expect(evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } }, 'ctx')).rejects.toThrow(
      /no LLM model available for provider 'p'/,
    );
  });
});
