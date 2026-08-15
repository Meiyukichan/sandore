/**
 * step-runner.ts（StepRunner）的单元测试：shell 成功/非零退出/超时/中止，
 * prompt 成功/终端失败/provider-model 三层回退。
 * @module @deepseek-ai/dsh-sandore-microflow/src/step-runner.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from '../../workflow/src/schema.ts';
import { textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeLlm } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell } from '../../workflow/tests/mocks/shell.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunRequest, StepRunnerConfig } from './step-runner.ts';

/** 组装 shell Step 定义（可选 Step 级 timeout，单位分钟）。 */
function shellStep(command: string, timeout?: number): WorkflowStep {
  return {
    id: 'step-sh',
    command: { type: 'shell', value: { command } },
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/** 组装 prompt Step 定义（可选 providerId/modelId）。 */
function promptStep(options?: { providerId?: string; modelId?: string }): WorkflowStep {
  return {
    id: 'step-p',
    command: {
      type: 'prompt',
      value: {
        promptText: 'summarize the input',
        ...(options?.providerId === undefined ? {} : { providerId: options.providerId }),
        ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
      },
    },
  };
}

/** 组装默认 Step 执行请求。 */
function request(step: WorkflowStep, overrides?: Partial<StepRunRequest>): StepRunRequest {
  return {
    step,
    workdir: '/tmp',
    originalInput: 'do the thing',
    previousOutputs: [],
    ...overrides,
  };
}

/** 组装 StepRunner 测试环境（注入 mock llm/shell）。 */
function harness(config: StepRunnerConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  runner: StepRunner;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) };
}

describe('StepRunner shell', () => {
  it('wraps stdout.text as a text ContentBlock on exitCode 0', async () => {
    const { shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'hello', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(runner.run(request(shellStep('echo hello')))).resolves.toEqual({
      output: [{ type: 'text', text: 'hello' }],
    });
  });

  it('throws STEP_EXECUTION with stderr summary on nonzero exit', async () => {
    const { shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom', truncated: false },
    });

    await expect(runner.run(request(shellStep('false')))).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
    await expect(runner.run(request(shellStep('false')))).rejects.toThrow(/boom/);
  });

  it('maps timedOut to STEP_TIMEOUT', async () => {
    const { shell, runner } = harness({ defaultTimeoutMs: 1 });
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(runner.run(request(shellStep('sleep 10')))).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('derives timeoutMs from the Step timeout in minutes when present', async () => {
    const { shell, runner } = harness({ defaultTimeoutMs: 60000 });
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    // Step 定义 timeout: 0.001 分钟 → 60ms，优先于引擎 defaultTimeoutMs。
    await expect(runner.run(request(shellStep('sleep 10', 0.001)))).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(shell.specs[0]?.timeoutMs).toBe(60);
  });

  it('maps aborted to STEP_EXECUTION', async () => {
    const { shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      aborted: true,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(runner.run(request(shellStep('sleep 10')))).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });
});

describe('StepRunner prompt', () => {
  it('aggregates block-end into ContentBlock[] on success', async () => {
    const { llm, runner } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const result = await runner.run(request(promptStep()));
    expect(result.output).toEqual([{ type: 'text', text: 'summary' }]);
  });

  it('throws STEP_EXECUTION with failure.message on finish error', async () => {
    const { llm, runner } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('', { kind: 'error', failure: { message: 'model exploded', code: 'X' } });

    await expect(runner.run(request(promptStep()))).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
    await expect(runner.run(request(promptStep()))).rejects.toThrow(/model exploded/);
  });

  it('throws STEP_EXECUTION with no LLM provider available when directory is empty', async () => {
    const { runner } = harness();
    await expect(runner.run(request(promptStep()))).rejects.toThrow(/no LLM provider available/);
  });

  it('prefers the step definition providerId over config and directory', async () => {
    const { llm, runner } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'b', defaultModel: 'b-model' });
    llm.providers.push({ id: 'c', name: 'Directory' });
    llm.models.set('c', [{ provider: 'c', id: 'c-model', name: 'Directory Model' }]);
    llm.streamHandler = () => textChunks('ok');

    await runner.run(request(promptStep({ providerId: 'a', modelId: 'a-model' })));

    expect(llm.calls[0]?.provider).toBe('a');
    expect(llm.calls[0]?.model).toBe('a-model');
  });

  it('falls back to config provider/model when the step omits them', async () => {
    const { llm, runner } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'b', defaultModel: 'b-model' });
    llm.streamHandler = () => textChunks('ok');

    await runner.run(request(promptStep()));

    expect(llm.calls[0]?.provider).toBe('b');
    expect(llm.calls[0]?.model).toBe('b-model');
  });
});
