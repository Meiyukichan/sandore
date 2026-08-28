/**
 * step-runner.ts（StepRunner）的单元测试：shell 成功/非零退出/超时/中止/stdin
 * 注入，prompt 经可续接子代理成功/终端失败/provider-model 三层回退/透传变量替换，
 * agent/skill/mcp 可续接子代理/fillParams，skill/mcp 名称校验与前缀。双通道 ask
 * 重构（4.4）后不再有 `[[SANDORE_ASK]]` 标记块转接/引导——子代理提问走
 * child-scope ask_user_question 工具（workflow/ask-tool.ts），本 spec 覆盖标记块
 * 按普通输出透传 + 无 toolFilter deny + 无引导注入。
 * @module dsh-sandore/microflow/src/step-runner.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from '../workflow/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { textChunks } from '../tests/mocks/llm.ts';
import { FakeLlm } from '../tests/mocks/llm.ts';
import { FakeShell } from '../tests/mocks/shell.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunRequest, StepRunnerConfig } from './step-runner.ts';
import type { SubagentSettlement, SubagentStopReason } from './subagents.ts';

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
    executedId: 'exec-1',
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

  it('passes JSON stdin through shell.run when inputFrom resolves to content', async () => {
    const { subprocess, shell, runner } = harness();
    const previousOutputs = [{ name: 'prev', id: 'step-p', returnPrompt: 'hello', files: [] }];
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(request(shellStepWithInputFrom('node read-stdin.js'), { previousOutputs }));

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs).toHaveLength(1);
    expect(shell.specs[0]?.stdin).toEqual(JSON.stringify(previousOutputs));
    expect(shell.specs[0]?.command).toBe('node read-stdin.js');
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

  it('passes merged env through shell.run when non-empty passThroughVars are present', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(
      request(shellStep('echo $projectName'), { passThroughVars: { projectName: 'sandore', empty: '' } }),
    );

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs).toHaveLength(1);
    expect(shell.specs[0]?.env).toEqual({ projectName: 'sandore' });
  });

  it('injects in-loop-turn and all-loop-turn into shell env when loopTurn > 0', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(
      request(shellStep('echo hi'), {
        passThroughVars: { projectName: 'sandore' },
        loopTurn: 3,
        loopMaxIterations: 5,
      }),
    );

    expect(shell.specs[0]?.env).toEqual({
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

  it('maps shell timedOut to STEP_TIMEOUT', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      timeoutMs: 60000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(
      runner.run(request(shellStep('sleep 10'), { passThroughVars: { a: '1' } })),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('replaces ${projectName} in the shell command with its passThroughVar value', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(request(shellStep('echo ${projectName}'), { passThroughVars: { projectName: 'sandore' } }));

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs[0]?.command).toBe('echo sandore');
  });

  it('keeps quoted arguments intact in the shell command string', async () => {
    const { subprocess, shell, runner } = harness();
    shell.runHandler = async spec => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await runner.run(request(shellStep('echo "hello world"'), { passThroughVars: { a: '1' } }));

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs[0]?.command).toBe('echo "hello world"');
  });
});

describe('StepRunner prompt', () => {
  it('runs via continuable subagent and returns sessionMeta with real childId', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(child);

    const result = await runner.run(request(promptStep()));

    // 决策 D3：prompt 经 startContinuable 拉起可续接子代理（非临时 llm.stream）。
    expect(subagents.continuableStarts).toHaveLength(1);
    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('summarize the input');
    expect(result.output).toEqual([{ type: 'text', text: 'summary' }]);
    expect(result.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'prompt' });
  });

  it('keeps only the latest 10 session message lines in sessionMessages (截断持久化体积)', async () => {
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    // 15 条 assistant/message 事件 → 15 条消息行；采集后应只保留最新 10 条
    // （StepChatPanel 实时订阅不读 sessionMessages，合成会话兜底也只展示最近 N 条）。
    for (let index = 0; index < 15; index += 1) {
      child.session.append(assistantMessageEvent([{ type: 'text', text: `msg-${index}` }], index));
    }
    agents.register(child);

    const result = await runner.run(request(promptStep()));

    expect(result.sessionMessages).toHaveLength(10);
    expect(result.sessionMessages?.map(message => message.text)).toEqual([
      'msg-5', 'msg-6', 'msg-7', 'msg-8', 'msg-9',
      'msg-10', 'msg-11', 'msg-12', 'msg-13', 'msg-14',
    ]);
  });

  it('throws STEP_EXECUTION when the subagent settle errors (model failure → failed)', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(promptStep()));
    ctrl.settle('child-1', 'error');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('throws STEP_EXECUTION with no LLM provider available when directory is empty', async () => {
    const { runner } = harness();
    await expect(runner.run(request(promptStep()))).rejects.toThrow(/no LLM provider available/);
  });

  it('prefers the step definition providerId over config and directory', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'b',
      defaultModel: 'b-model',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep({ providerId: 'a', modelId: 'a-model' })));

    // provider 参数是 DSH subagent provider 注册名（缺省 'fork'），与模型路由解耦；
    // 模型 provider 经 agentOptions 承载。
    expect(subagents.continuableStarts[0]?.provider).toBe('fork');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.provider).toBe('a');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.model).toBe('a-model');
  });

  it('falls back to config provider/model when the step omits them', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'b',
      defaultModel: 'b-model',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep()));

    expect(subagents.continuableStarts[0]?.provider).toBe('fork');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.provider).toBe('b');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.model).toBe('b-model');
  });

  it('keeps the DSH subagent provider decoupled from the model provider in agentOptions', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep({ providerId: 'p', modelId: 'm' })));

    // 回归防护：startContinuable 的 provider 参数必须是 DSH subagent provider 注册名
    // （缺省 'fork'），绝不能是模型 provider id（'p'）——否则真实 DSH 运行时报
    // `no subagent provider registered for "p"`。模型路由只经 agentOptions 承载。
    expect(subagents.continuableStarts[0]?.provider).toBe('fork');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.provider).toBe('p');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.model).toBe('m');
  });

  it('honors a config subagentProvider override while keeping model routing in agentOptions', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      subagentProvider: 'spawn',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep({ providerId: 'p', modelId: 'm' })));

    expect(subagents.continuableStarts[0]?.provider).toBe('spawn');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.provider).toBe('p');
    expect(subagents.continuableStarts[0]?.request.agentOptions?.model).toBe('m');
  });

  it('replaces ${projectName} with passThroughVar and leaves unknown vars intact', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(
      request(promptStep({ promptText: 'build ${projectName} for ${unknown}' }), {
        passThroughVars: { projectName: 'sandore' },
      }),
    );

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
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
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    // v6：fillParams 也走可续接子代理——child-1 是 fillParams 子代理（输出填充结果），
    // child-2 是主 step 子代理（输出 'done'）。startContinuable 顺序：fillParams → 主 step。
    const fillChild = new FakeAgent('child-1');
    fillChild.session.append(assistantMessageEvent([{ type: 'text', text: '{"lintErrorCount": 3}' }]));
    agents.register(fillChild);
    const child = new FakeAgent('child-2');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(request(agentStep({ agentParamsTemplate: '审查：${lintErrorCount} 个错误' })));

    // fillParams 子代理收到填充提示词（含参数模板原文）。
    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).toContain('审查：${lintErrorCount} 个错误');
    // 主 step 子代理提示词：<Params> 内为 fillParams 输出。
    const promptText = textOf(subagents.continuableStarts[1]?.request.prompt[0]);
    expect(promptText).toContain('<Params>');
    expect(promptText).toContain('{"lintErrorCount": 3}');
  });

  it('falls back to agentParamsTemplate raw text when fillParams subagent produces no output', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    // fillParams 子代理（child-1）无 assistant 输出 → 回退模板原文。
    const fillChild = new FakeAgent('child-1');
    agents.register(fillChild);
    const child = new FakeAgent('child-2');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[1]?.request.prompt[0]);
    expect(promptText).toContain('<Params>');
    expect(promptText).toContain('TEMPLATE_RAW');
  });

  it('falls back to agentParamsTemplate raw text when fillParams subagent settle is not completed', async () => {
    const ctrl = settleController();
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      awaitSubagentSettlement: ctrl.awaitSubagentSettlement,
    });
    // fillParams 子代理（child-1）settle aborted → 回退模板原文。
    const fillChild = new FakeAgent('child-1');
    agents.register(fillChild);
    const child = new FakeAgent('child-2');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    const runP = runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })));
    ctrl.settle('child-1', 'aborted');
    ctrl.settle('child-2', 'completed');
    await expect(runP).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[1]?.request.prompt[0]);
    expect(promptText).toContain('<Params>');
    expect(promptText).toContain('TEMPLATE_RAW');
  });

  it('falls back to agentParamsTemplate raw text when fillParams subagent start throws', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    // fillParams 子代理启动抛错（mock startContinuable 首次调用抛）→ 回退模板原文。
    const originalStart = subagents.startContinuable.bind(subagents);
    let first = true;
    subagents.startContinuable = (spec => {
      if (first) {
        first = false;
        throw new Error('start exploded');
      }
      return originalStart(spec);
    }) as typeof subagents.startContinuable;
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await expect(runner.run(request(agentStep({ agentParamsTemplate: 'TEMPLATE_RAW' })))).resolves.toBeDefined();

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('<Params>');
    expect(promptText).toContain('TEMPLATE_RAW');
  });
});

describe('StepRunner 双通道 ask 重构（4.4：[[SANDORE_ASK]] 机制已删除）', () => {
  it('treats a [[SANDORE_ASK]] marker block as ordinary output (no delegation hook)', async () => {
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]]' },
    ]));
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    agents.register(child);

    const result = await runner.run(request(agentStep()));

    // 标记块机制已删：输出原样透传（子代理提问走 child-scope ask_user_question 工具）。
    expect(result.output).toEqual([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]]' },
    ]);
    expect(result.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
  });

  it('does not inject the [[SANDORE_ASK]] guidance section into the subagent prompt', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep()));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 引导节已删：不再出现「向用户提问」/ [[SANDORE_ASK]] 标记说明。
    expect(promptText).not.toContain('## 向用户提问');
    expect(promptText).not.toContain('[[SANDORE_ASK]]');
  });

  it('does not deny ask_user_question via toolFilter (child-scope 同名工具遮蔽全局版)', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep()));

    // toolFilter deny 已删：子代理提问能力由 workflow 层 registerContinuableSetup 注入的
    // child-scope ask_user_question 工具提供（child-scope 同名注册天然遮蔽全局版）。
    expect(subagents.continuableStarts[0]?.request.toolFilter).toBeUndefined();
  });

  it('applies the no-toolFilter/no-guidance behavior to agent subagents as well (shared runSubagent path)', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent output' }]));
    agents.register(child);

    await runner.run(request(agentStep({ providerId: 'p', modelId: 'm' })));

    // runSubagent 为 prompt/agent/skill/mcp 四路共用：agent 路同样无 deny、无引导。
    expect(subagents.continuableStarts[0]?.request.toolFilter).toBeUndefined();
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).not.toContain('[[SANDORE_ASK]]');
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

describe('StepRunner ## 任务规则 注入（缺陷 7）', () => {
  /** 组装带 resolvedRules 的请求（模拟 StageExecutor 解析后的 3 级合并结果）。 */
  function requestWithRules(step: WorkflowStep, rules: Record<string, string>): StepRunRequest {
    return {
      step,
      executedId: 'exec-1',
      workdir: '/tmp',
      originalInput: 'do the thing',
      previousOutputs: [],
      stageId: 'stg-1',
      resolvedRules: rules,
    };
  }

  it('prompt 路注入 ## 任务规则 节（非空 resolvedRules）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(requestWithRules(promptStep(), {
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 任务规则');
    expect(promptText).toContain('- **chinese-output**: 所有输出必须使用中文');
    expect(promptText).toContain('- **no-direct-commit**: 禁止直接执行 git commit');
    // 位置对齐 v6：## 任务规则 在 ## 参考信息 之前（用户指令 → 任务规则 → 参考信息）。
    const rulesIdx = promptText.indexOf('## 任务规则');
    const refIdx = promptText.indexOf('## 参考信息');
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(refIdx);
  });

  it('agent 路注入 ## 任务规则 节（非空 resolvedRules）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(requestWithRules(agentStep(), { 'chinese-output': '所有输出必须使用中文' }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 任务规则');
    expect(promptText).toContain('- **chinese-output**: 所有输出必须使用中文');
  });

  it('skill 路注入 ## 任务规则 节（非空 resolvedRules）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      skills: ['code-review-skill'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(requestWithRules(skillStep('code-review-skill'), { 'chinese-output': '所有输出必须使用中文' }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 任务规则');
    expect(promptText).toContain('- **chinese-output**: 所有输出必须使用中文');
  });

  it('mcp 路注入 ## 任务规则 节（非空 resolvedRules）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      mcps: ['filesystem-mcp'],
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    await runner.run(requestWithRules(mcpStep('filesystem-mcp'), { 'chinese-output': '所有输出必须使用中文' }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 任务规则');
    expect(promptText).toContain('- **chinese-output**: 所有输出必须使用中文');
  });

  it('resolvedRules 缺省时不注入 ## 任务规则 节（向后兼容）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep()));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 头部三点列表含 `` `## 任务规则` `` 引用（行内反引号），正文节标题为独立行
    // `\n## 任务规则\n`——此处断言正文节不注入。
    expect(promptText).not.toContain('\n## 任务规则\n');
  });

  it('resolvedRules 为空对象时不注入 ## 任务规则 节', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(requestWithRules(promptStep(), {}));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).not.toContain('\n## 任务规则\n');
  });
});

/**
 * settle 测试用控制器：可手动触发 settle 的 `awaitSubagentSettlement` 注入实现。
 * 缓冲 settle（settle 早于 awaiter 注册时存入 buffered，awaiter 注册即消费）——对齐
 * workflow-engine 的缓冲路由语义。
 */
function settleController(): {
  awaitSubagentSettlement: NonNullable<StepRunnerConfig['awaitSubagentSettlement']>;
  settle: (childId: string, stopReason: SubagentStopReason, output?: readonly ContentBlock[]) => void;
} {
  const pending = new Map<string, (s: SubagentSettlement) => void>();
  const buffered = new Map<string, SubagentSettlement>();
  const awaitSubagentSettlement: NonNullable<StepRunnerConfig['awaitSubagentSettlement']> = (
    childId,
    _signal,
  ) =>
    new Promise<SubagentSettlement>((resolve) => {
      const buf = buffered.get(childId);
      if (buf !== undefined) {
        buffered.delete(childId);
        resolve(buf);
        return;
      }
      pending.set(childId, resolve);
    });
  const settle = (
    childId: string,
    stopReason: SubagentStopReason,
    output?: readonly ContentBlock[],
  ): void => {
    const settlement: SubagentSettlement = {
      childId,
      stopReason,
      ...(output === undefined ? {} : { output }),
    };
    const resolve = pending.get(childId);
    if (resolve !== undefined) {
      pending.delete(childId);
      resolve(settlement);
    } else {
      buffered.set(childId, settlement);
    }
  };
  return { awaitSubagentSettlement, settle };
}

/** 组装带 settle 注入的 StepRunner harness（agent Step + 真实 childId 占位）。 */
function settleHarness(ctrl: ReturnType<typeof settleController>): {
  agents: FakeAgentRegistry;
  subagents: FakeSubagents;
  runner: StepRunner;
} {
  const { agents, subagents, runner } = harness({
    defaultTimeoutMs: 60000,
    defaultProvider: 'p',
    defaultModel: 'm',
    awaitSubagentSettlement: ctrl.awaitSubagentSettlement,
  });
  return { agents, subagents, runner };
}

describe('StepRunner subagent settle completion (DSH subagent/end alignment)', () => {
  // 完成判定对齐 DSH `subagent/end`：collectSubagentOutput 等 settle（非 whenIdle），
  // 按 stopReason 路由：completed→完成 / aborted→STEP_PAUSED / error·max-tokens·refusal→STEP_EXECUTION。

  it('settle(completed) returns the final assistant output as step output', async () => {
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'completed');
    const result = await runP;
    expect(result.output).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
  });

  it('settle(completed, output) returns the settlement output verbatim', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'completed', [{ type: 'text', text: 'settle output' }]);
    const result = await runP;
    expect(result.output).toEqual([{ type: 'text', text: 'settle output' }]);
  });

  it('settle(aborted) throws STEP_PAUSED (interrupt/pause → not failed)', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'aborted');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_PAUSED' });
  });

  it('settle(error) throws STEP_EXECUTION (failed)', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'error');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('settle(max-tokens) throws STEP_EXECUTION (token ceiling → failed)', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'max-tokens');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('settle(refusal) throws STEP_EXECUTION (declined → failed)', async () => {
    const child = new FakeAgent('child-1');
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'refusal');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('settle(completed) with no assistant output throws STEP_EXECUTION (no output)', async () => {
    const child = new FakeAgent('child-1'); // no events
    const ctrl = settleController();
    const { agents, runner } = settleHarness(ctrl);
    agents.register(child);

    const runP = runner.run(request(agentStep()));
    ctrl.settle('child-1', 'completed');
    await expect(runP).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });
});

// ── v6：前置输出按 step.inputFrom 过滤（配置只依赖 sce1 却显示所有前置 step） ──
describe('StepRunner inputFrom 前置输出过滤（v6）', () => {
  it('只注入 inputFrom 声明的依赖（path 匹配），未声明的前置不出现', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const step: WorkflowStep = { ...promptStep(), inputFrom: [{ path: 'sce1' }] };
    const previousOutputs = [
      { name: 'sce1', id: 'sce1', returnPrompt: 'sce1 output', files: [] },
      { name: 'parallel1', id: 'parallel1', returnPrompt: 'miku', files: [] },
      { name: 'sce2', id: 'sce2', returnPrompt: 'sce2 old round', files: [] },
    ];

    await runner.run(request(step, { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('前置Step: sce1');
    expect(promptText).toContain('sce1 output');
    expect(promptText).not.toContain('前置Step: parallel1');
    expect(promptText).not.toContain('前置Step: sce2');
    expect(promptText).not.toContain('miku');
  });

  it('同 stepId 多段（循环/重试）去重，只保留最近一段', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const step: WorkflowStep = { ...promptStep(), inputFrom: [{ path: 'sce1' }] };
    const previousOutputs = [
      { name: 'sce1', id: 'sce1', returnPrompt: 'old round', files: [] },
      { name: 'sce1', id: 'sce1', returnPrompt: 'nearest round', files: [] },
    ];

    await runner.run(request(step, { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('nearest round');
    expect(promptText).not.toContain('old round');
    expect(promptText).toContain('前置Step: sce1');
  });

  it('inputFrom 未配置时保留全量前置输出（向后兼容）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const previousOutputs = [
      { name: 'sce1', id: 'sce1', returnPrompt: 'sce1 output', files: [] },
      { name: 'parallel1', id: 'parallel1', returnPrompt: 'miku', files: [] },
    ];

    await runner.run(request(promptStep(), { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('前置Step: sce1');
    expect(promptText).toContain('前置Step: parallel1');
    expect(promptText).toContain('miku');
  });
});
