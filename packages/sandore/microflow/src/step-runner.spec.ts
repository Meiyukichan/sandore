/**
 * step-runner.ts（StepRunner）的单元测试：shell 成功/非零退出/超时/中止/stdin
 * 注入，prompt 成功/终端失败/provider-model 三层回退/透传变量替换，agent 可续接
 * 子代理/fillParams，skill/mcp 名称校验与前缀。
 * @module @deepseek-ai/dsh-sandore-microflow/src/step-runner.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../../workflow/tests/mocks/agents.ts';
import { textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeLlm } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunRequest, StepRunnerConfig } from './step-runner.ts';

/** 提取文本 ContentBlock 的纯文本（非文本块返回空串）。 */
function textOf(block: ContentBlock | undefined): string {
  return block !== undefined && block.type === 'text' ? block.text : '';
}

/** 组装 shell Step 定义（可选 Step 级 timeout，单位分钟）。 */
function shellStep(command: string, timeout?: number): WorkflowStep {
  return {
    id: 'step-sh',
    command: { type: 'shell', value: { command } },
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/** 组装带 inputFrom 的 shell Step 定义。 */
function shellStepWithInputFrom(command: string): WorkflowStep {
  return {
    id: 'step-sh',
    command: { type: 'shell', value: { command } },
    inputFrom: [{ id: 'in-1', path: 'step-p' }],
  };
}

/** 组装 prompt Step 定义（可选 providerId/modelId/promptText）。 */
function promptStep(options?: { providerId?: string; modelId?: string; promptText?: string }): WorkflowStep {
  return {
    id: 'step-p',
    command: {
      type: 'prompt',
      value: {
        promptText: options?.promptText ?? 'summarize the input',
        ...(options?.providerId === undefined ? {} : { providerId: options.providerId }),
        ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
      },
    },
  };
}

/** 组装 agent Step 定义（可选 providerId/modelId/agentParamsTemplate）。 */
function agentStep(options?: { providerId?: string; modelId?: string; agentParamsTemplate?: string }): WorkflowStep {
  return {
    id: 'step-a',
    command: {
      type: 'agent',
      value: {
        promptText: 'code-reviewer',
        ...(options?.agentParamsTemplate === undefined ? {} : { agentParamsTemplate: options.agentParamsTemplate }),
        ...(options?.providerId === undefined ? {} : { providerId: options.providerId }),
        ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
      },
    },
  };
}

/** 组装 skill Step 定义。 */
function skillStep(promptText: string): WorkflowStep {
  return {
    id: 'step-sk',
    command: { type: 'skill', value: { promptText } },
  };
}

/** 组装 mcp Step 定义。 */
function mcpStep(promptText: string): WorkflowStep {
  return {
    id: 'step-m',
    command: { type: 'mcp', value: { promptText } },
  };
}

/** 组装默认 Step 执行请求。 */
function request(step: WorkflowStep, overrides?: Partial<StepRunRequest>): StepRunRequest {
  return {
    step,
    workdir: '/tmp',
    originalInput: 'do the thing',
    previousOutputs: [],
    stageId: 'stg-1',
    ...overrides,
  };
}

/** 组装 StepRunner 测试环境（注入 mock llm/shell/subagents/agents/subprocess）。 */
function harness(config: StepRunnerConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  subagents: FakeSubagents;
  agents: FakeAgentRegistry;
  subprocess: FakeSubprocess;
  runner: StepRunner;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subagents = new FakeSubagents();
  const agents = new FakeAgentRegistry();
  const subprocess = new FakeSubprocess();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  return { ctx, llm, shell, subagents, agents, subprocess, runner: new StepRunner(ctx, config) };
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

  it('uses subprocess.spawn with JSON stdin when inputFrom resolves to content', async () => {
    const { subprocess, shell, runner } = harness();
    const previousOutputs = [{ name: 'prev', id: 'step-p', returnPrompt: 'hello', files: [] }];

    await runner.run(request(shellStepWithInputFrom('node read-stdin.js'), { previousOutputs }));

    expect(subprocess.specs).toHaveLength(1);
    expect(shell.specs).toHaveLength(0);
    expect(subprocess.specs[0]?.stdio.stdin).toEqual({ data: JSON.stringify(previousOutputs) });
    expect(subprocess.specs[0]?.argv[0]).toBe('/usr/bin/node');
  });

  it('still uses shell.run for a simple shell step without stdin/env injection', async () => {
    const { subprocess, shell, runner } = harness();
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
    expect(shell.specs).toHaveLength(1);
    expect(subprocess.specs).toHaveLength(0);
  });

  it('uses subprocess.spawn with merged env when non-empty passThroughVars are present', async () => {
    const { subprocess, shell, runner } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await runner.run(
      request(shellStep('echo $projectName'), { passThroughVars: { projectName: 'sandore', empty: '' } }),
    );

    expect(subprocess.specs).toHaveLength(1);
    expect(shell.specs).toHaveLength(0);
    expect(subprocess.specs[0]?.env).toEqual({ projectName: 'sandore' });
  });

  it('injects in-loop-turn and all-loop-turn into subprocess env when loopTurn > 0', async () => {
    const { subprocess, runner } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await runner.run(
      request(shellStep('echo hi'), {
        passThroughVars: { projectName: 'sandore' },
        loopTurn: 3,
        loopMaxIterations: 5,
      }),
    );

    expect(subprocess.specs[0]?.env).toEqual({
      projectName: 'sandore',
      'in-loop-turn': '3',
      'all-loop-turn': '5',
    });
  });

  it('does not inject empty passThroughVars and stays on the simple path when nothing non-empty remains', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(request(shellStep('echo hi'), { passThroughVars: { empty: '' } }));

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs).toHaveLength(1);
  });

  it('maps subprocess timedOut to STEP_TIMEOUT', async () => {
    const { subprocess, runner } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true });

    await expect(
      runner.run(request(shellStep('sleep 10'), { passThroughVars: { a: '1' } })),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('replaces ${projectName} in the shell command with its passThroughVar value', async () => {
    const { subprocess, runner } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await runner.run(request(shellStep('echo ${projectName}'), { passThroughVars: { projectName: 'sandore' } }));

    expect(subprocess.specs[0]?.argv).toEqual(['/usr/bin/echo', 'sandore']);
  });

  it('splits a quoted shell command preserving spaces within quotes', async () => {
    const { subprocess, runner } = harness();
    subprocess.outcomeHandler = () => ({ exitCode: 0, signal: null });

    await runner.run(request(shellStep('echo "hello world"'), { passThroughVars: { a: '1' } }));

    expect(subprocess.specs[0]?.argv).toEqual(['/usr/bin/echo', 'hello world']);
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

  it('replaces ${projectName} with passThroughVar and leaves unknown vars intact', async () => {
    const { llm, runner } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('ok');

    await runner.run(
      request(promptStep({ promptText: 'build ${projectName} for ${unknown}' }), {
        passThroughVars: { projectName: 'sandore' },
      }),
    );

    const promptText = textOf(llm.calls[0]?.messages[0]?.content[0]);
    expect(promptText).toContain('sandore');
    expect(promptText).not.toContain('${projectName}');
    expect(promptText).toContain('${unknown}');
  });
});

describe('StepRunner agent', () => {
  it('runs via continuable subagent and returns sessionMeta with real childId', async () => {
    const { subagents, agents, runner } = harness();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent output' }]));
    agents.register(child);

    const result = await runner.run(request(agentStep({ providerId: 'p', modelId: 'm' })));

    expect(subagents.continuableStarts).toHaveLength(1);
    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('code-reviewer');
    expect(result.output).toEqual([{ type: 'text', text: 'agent output' }]);
    expect(result.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
  });

  it('prefixes agent prompt with 使用 Agent： when name is in agents', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      agents: ['code-reviewer'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(request(agentStep()));

    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('使用 Agent：code-reviewer');
  });

  it('injects 当前Step参数 sub-section when agentParamsTemplate is defined', async () => {
    const { subagents, agents, llm, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    llm.streamHandler = () => textChunks('{"lintErrorCount": 3}');
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(request(agentStep({ agentParamsTemplate: '审查：${lintErrorCount} 个错误' })));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('### 当前Step参数');
    expect(promptText).toContain('{"lintErrorCount": 3}');
  });

  it('falls back to agentParamsTemplate raw text when fillParams temp session errors', async () => {
    const { subagents, agents, llm, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    llm.streamHandler = () => textChunks('', { kind: 'error', failure: { message: 'boom', code: 'X' } });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('### 当前Step参数');
    expect(promptText).toContain('TEMPLATE_RAW');
  });

  it('falls back to agentParamsTemplate raw text when fillParams temp session aborts', async () => {
    const { subagents, agents, llm, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    llm.streamHandler = () => textChunks('', { kind: 'aborted', failure: { message: 'cancelled', code: 'X' } });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('### 当前Step参数');
    expect(promptText).toContain('TEMPLATE_RAW');
  });

  it('falls back to agentParamsTemplate raw text when fillParams temp session stream throws', async () => {
    const { subagents, agents, llm, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    llm.streamHandler = () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      throw new Error('stream exploded');
    })();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('### 当前Step参数');
    expect(promptText).toContain('TEMPLATE_RAW');
  });
});

describe('StepRunner delegated ask hook', () => {
  it('invokes onDelegatedAsk when subagent output contains an ask marker and uses the re-read output', async () => {
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]]' },
    ]));
    let idleCalls = 0;
    child.whenIdle = async () => {
      idleCalls += 1;
      if (idleCalls === 2) {
        child.session.append(assistantMessageEvent([{ type: 'text', text: 'final answer' }]));
      }
    };
    const delegated: Array<{ childId: string; output: ContentBlock[] }> = [];
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      onDelegatedAsk: async input => {
        delegated.push({ childId: input.childId, output: input.output });
        return true;
      },
    });
    agents.register(child);

    const result = await runner.run(request(agentStep()));

    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.childId).toBe('child-1');
    expect(result.output).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(result.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
  });

  it('keeps the original output when onDelegatedAsk returns false (invalid marker)', async () => {
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' },
    ]));
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      onDelegatedAsk: async () => false,
    });
    agents.register(child);

    const result = await runner.run(request(agentStep()));

    expect(result.output).toEqual([{ type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' }]);
  });

  it('terminates when the subagent keeps returning the same ask marker (no progress)', async () => {
    const child = new FakeAgent('child-1');
    const marker = '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]]';
    child.session.append(assistantMessageEvent([{ type: 'text', text: marker }]));
    // 子代理在每轮 followup 后重新发出同一合法标记块（无进展）。
    child.whenIdle = async () => {
      child.session.append(assistantMessageEvent([{ type: 'text', text: marker }]));
    };
    let delegated = 0;
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      onDelegatedAsk: async () => {
        delegated += 1;
        return true;
      },
    });
    agents.register(child);

    const result = await runner.run(request(agentStep()));

    // 无进展守卫：仅转接一轮即 break，按普通输出返回标记块。
    expect(delegated).toBe(1);
    expect(result.output).toEqual([{ type: 'text', text: marker }]);
  });

  it('terminates after MAX_DELEGATED_ASK_ROUNDS when the subagent keeps asking new questions', async () => {
    const child = new FakeAgent('child-1');
    const markerFor = (n: number) => `[[SANDORE_ASK]]{"questions":[{"id":"q${n}","question":"Q${n}?"}]}[[/SANDORE_ASK]]`;
    child.session.append(assistantMessageEvent([{ type: 'text', text: markerFor(1) }]));
    // 每轮 followup 后子代理都发出「不同」的合法标记块（无进展守卫不触发，靠最大轮数兜底）。
    let idleCalls = 0;
    child.whenIdle = async () => {
      idleCalls += 1;
      if (idleCalls >= 2) {
        child.session.append(assistantMessageEvent([{ type: 'text', text: markerFor(idleCalls) }]));
      }
    };
    let delegated = 0;
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      onDelegatedAsk: async () => {
        delegated += 1;
        return true;
      },
    });
    agents.register(child);

    const result = await runner.run(request(agentStep()));

    // 最大轮数守卫：最多转接 MAX_DELEGATED_ASK_ROUNDS（3）轮即 break。
    expect(delegated).toBe(3);
    expect(result.output).toEqual([{ type: 'text', text: markerFor(4) }]);
  });

  it('does not call onDelegatedAsk when the output has no marker', async () => {
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ordinary output' }]));
    let delegated = 0;
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      onDelegatedAsk: async () => {
        delegated += 1;
        return true;
      },
    });
    agents.register(child);

    await runner.run(request(agentStep()));

    expect(delegated).toBe(0);
  });
});

describe('StepRunner skill/mcp', () => {
  it('prefixes skill prompt with 使用 skill： when name is in skills', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      skills: ['code-review-skill'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(request(skillStep('code-review-skill')));

    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('使用 skill：code-review-skill');
  });

  it('falls back to plain prompt without error when skill name is not in skills', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      skills: ['other-skill'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(skillStep('unknown-skill')))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('unknown-skill');
    expect(promptText).not.toContain('使用 skill：');
  });

  it('prefixes mcp prompt with 使用 MCP： when name is in mcps', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      mcps: ['filesystem-mcp'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(request(mcpStep('filesystem-mcp')));

    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('使用 MCP：filesystem-mcp');
  });
});
