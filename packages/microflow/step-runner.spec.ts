/**
 * step-runner.ts（StepRunner）的单元测试：shell 成功/非零退出/超时/中止/stdin
 * 注入，prompt 经可续接子代理成功/终端失败/provider-model 三层回退/透传变量替换，
 * agent/skill/mcp 可续接子代理/fillParams，skill/mcp 名称校验与前缀。双通道 ask
 * 重构（4.4）后不再有 `[[SANDORE_ASK]]` 标记块转接/引导——子代理提问走全局注册的
 * sandore_ask_user_question 工具（execute 期 gate 仅放行 sandore 子代理，见
 * workflow/ask-tool.ts），本 spec 覆盖标记块按普通输出透传 + toolFilter deny 全局版
 * ask_user_question + 无引导注入。
 * @module @meiyukichan/dsh-sandore/microflow/src/step-runner.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from '../workflow/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { textChunks } from '../tests/mocks/llm.ts';
import { FakeLlm } from '../tests/mocks/llm.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunRequest, StepRunnerConfig } from './step-runner.ts';
import type { Agent, SubagentSettlement, SubagentStopReason } from './subagents.ts';

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

  it('shell step 携带宿主会话的 sandbox 策略（workspace = 会话 cwd）', async () => {
    // 宿主主代理（session cwd = 项目路径）：shell step 应携带 per-call 策略，
    // 而非回落 deployment 默认（启动目录——主目录启动会触发 Windows ACL 边界冲突）。
    const hostAgent = {
      id: 'host-1',
      session: { id: 'host-1', header: { cwd: '/project/test' }, events: [] },
    } as unknown as Agent;
    const { ctx, shell, runner } = harness({ defaultTimeoutMs: 60000, hostAgent });
    // FakeSandboxPolicy：workspaceRoot 取传入会话的 cwd（对齐 DSH sandbox-policy 的 resolve）。
    ctx.provide('sandboxPolicy', {
      resolve: (request?: { session?: { header?: { cwd?: string } } }) => ({
        mode: 'workspace-write' as const,
        workspaceRoot: request?.session?.header?.cwd ?? '(fallback)',
      }),
    });
    shell.runHandler = async spec => successResult(spec, 'ok');

    await runner.run(request(shellStep('echo hi')));
    expect(shell.requests[0]?.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: '/project/test' });
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

  it('不再采集 sessionMessages（state 冗余移除；改由 RPC 读取期从会话现算）', async () => {
    const { agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    // 15 条 assistant/message 事件：过去会采集并被 `slice(-10)` 截断写进
    // `executed.sessionMessages`（实测占 state 的 41%–54%）。现在执行结果**不带**该字段。
    for (let index = 0; index < 15; index += 1) {
      child.session.append(assistantMessageEvent([{ type: 'text', text: `msg-${index}` }], index));
    }
    agents.register(child);

    const result = await runner.run(request(promptStep()));

    // 结果面只有 output + sessionMeta；展示所需的会话消息行由
    // `SandoreEngine.hydrateStateMessages` 在 getInstanceState RPC 读取时从
    // `sessionMeta.childId` 指向的会话现算（每段尾部 10 条）。
    expect(result).not.toHaveProperty('sessionMessages');
    expect(result.sessionMeta?.childId).toBe('child-1');
    expect(Object.keys(result).sort()).toEqual(['output', 'sessionMeta']);
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

    // provider 参数是 DSH subagent provider 注册名（缺省 `spawn` = **全新子代理**，
    // 不继承父会话上下文），与模型路由解耦；模型 provider 经 agentOptions 承载。
    expect(subagents.continuableStarts[0]?.provider).toBe('spawn');
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

    expect(subagents.continuableStarts[0]?.provider).toBe('spawn');
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
    // （缺省 `spawn` = 全新子代理），绝不能是模型 provider id（'p'）——否则真实 DSH 运行时报
    // `no subagent provider registered for "p"`。模型路由只经 agentOptions 承载。
    expect(subagents.continuableStarts[0]?.provider).toBe('spawn');
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

    // 标记块机制已删：输出原样透传（子代理提问走全局注册的 sandore_ask_user_question 工具）。
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

  it('denies the global ask_user_question via toolFilter (上游适配：ask 工具全局注册 + gate)', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request(promptStep()));

    // 上游适配（registerContinuableSetup 已删）：child-scope 遮蔽机制不复存在，改
    // request.toolFilter deny DSH 全局版 ask_user_question，提问走全局注册的
    // sandore_ask_user_question（execute 期 gate 仅放行 sandore 子代理）。
    // 架构决策 5：同时 deny `send_message`——DSH 只在子代理 scope 能解析出标准
    // send_message 时才注入「完成后向 parent 汇报」的指引（continuation.ts:495-500），
    // deny 后工具与指引一起消失，Step 产出由引擎 settle 通道收集。
    expect(subagents.continuableStarts[0]?.request.toolFilter).toEqual({ deny: ['ask_user_question', 'send_message'] });
  });

  it('applies the deny-toolFilter/no-guidance behavior to agent subagents as well (shared runSubagent path)', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent output' }]));
    agents.register(child);

    await runner.run(request(agentStep({ providerId: 'p', modelId: 'm' })));

    // runSubagent 为 prompt/agent/skill/mcp 四路共用：agent 路同样 deny 全局版提问工具
    // + deny send_message（架构决策 5）。
    expect(subagents.continuableStarts[0]?.request.toolFilter).toEqual({ deny: ['ask_user_question', 'send_message'] });
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).not.toContain('[[SANDORE_ASK]]');
    // 架构决策 5 的 prompt 侧弱约束：明确告知「没有向主代理发消息的工具」。
    expect(promptText).toContain('你没有向主代理发消息的工具，直接结束即可');
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

  it('T1：执行子代理 label = `<名称> · <childId>`（无 `step ` 前缀），childId 由引擎生成纯 UUID 并显式传入', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);

    await runner.run(request({ ...promptStep(), id: 'step-1846d923-133b-4617-9aac-b0b7e9344795', name: '分析问题' }));

    const spec = subagents.continuableStarts[0]!;
    // label 用 step **名称**（不是 id）拼 childId：真机缺陷是 `label: step ${step.id}` 撞上
    // DAG 编辑器生成的 `step-<uuid>` 形态 id → 界面显示 `step step-<uuid>`。
    expect(spec.label).toMatch(/^分析问题 · [0-9a-f-]{36}$/);
    expect(spec.label).not.toContain('step-1846d923');
    expect(spec.label.startsWith('step ')).toBe(false);
    // childId 由引擎生成并显式传入（ContinuableStartSpec.childId 可选；label 里要带它
    // 就必须先知道它）：纯 UUID，无前缀，且与 label 尾段完全一致。
    expect(spec.childId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(spec.label).toBe(`分析问题 · ${spec.childId}`);
  });

  it('未声明 inputFrom 时只注入**直接上游**（v7：默认 = DAG 入边，不是全量）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    // 仿 test-workflow：loop 的唯一流程上游是 sce3；其它 step（sce1/parallel1/sce2/修复问题）
    // 都已执行过但**不是上游**（真机缺陷形态：它们被整篇塞进了 loop 的参考信息）。
    const previousOutputs = [
      { name: 'sce1', id: 'sce1', returnPrompt: 'sce1 output', files: [] },
      { name: 'parallel1', id: 'parallel1', returnPrompt: 'miku', files: [] },
      { name: 'sce2', id: 'sce2', returnPrompt: 'counts 第 1 段', files: [] },
      { name: 'sce2', id: 'sce2', returnPrompt: 'counts 第 3 段', files: [] },
      { name: '修复问题', id: '修复问题', returnPrompt: 'fix 第 4 段', files: [] },
      { name: 'sce3', id: 'sce3', returnPrompt: 'sce3 输出 miku', files: [] },
    ];
    await runner.run(request(promptStep(), { previousOutputs, upstreamStepIds: ['sce3'] }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 只有直接上游出现，且只出现一次。
    expect(promptText).toContain('前置Step: sce3');
    expect(promptText).toContain('sce3 输出 miku');
    expect(promptText.split('前置Step: sce3').length - 1).toBe(1);
    expect(promptText).not.toContain('前置Step: sce1');
    expect(promptText).not.toContain('前置Step: parallel1');
    expect(promptText).not.toContain('前置Step: sce2');
    expect(promptText).not.toContain('前置Step: 修复问题');
    // 全局上下文仍在：用户原始需求块。
    expect(promptText).toContain('用户原始需求');
    expect(promptText).toContain('<ReferenceInfo>');
  });

  it('上游未产出内容时显式标注（v8 真机形态：loop 的上游 sce3 因条件分支从未执行）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    // 真机实例 session-33ca337f…：分支条件始终命中「proposal.md 已存在」→ sce3 **从未执行**
    //（真机 15 个实例一次都没跑过），而把 loop 送进执行的是 `修复问题` 的 exitTo 出口。
    const previousOutputs = [
      { name: 'sce1', id: 'sce1', returnPrompt: 'sce1 output', files: [] },
      { name: '修复问题', id: '修复问题', returnPrompt: 'counts.json times=58', files: [] },
    ];
    await runner.run(request(promptStep(), {
      previousOutputs,
      upstreamStepIds: ['sce3', '修复问题'],
      upstreamStepNames: { sce3: 'sce3', '修复问题': '修复问题' },
    }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 未产出的上游显式点名（不再静默留空 → 模型/人都能区分「依赖丢了」与「本来就没有」）。
    expect(promptText).toContain('上游未产出内容');
    expect(promptText).toContain('sce3 (id: sce3)：本次未执行或输出为空，无可注入内容');
    // 真出过力的上游照旧注入输出；未产出的那一个不产生「前置Step」块。
    expect(promptText).toContain('前置Step: 修复问题');
    expect(promptText).toContain('counts.json times=58');
    expect(promptText).not.toContain('前置Step: sce3');
  });

  it('上游都有产出时不出现「上游未产出内容」标注；声明的 inputFrom 未执行时同样标注', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    // 第二次 start 会拿到 child-2（FakeSubagents 每次 +1），注册表里必须有它才算 settle 成功。
    const second = new FakeAgent('child-2');
    second.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(second);
    const previousOutputs = [
      { name: 'sce3', id: 'sce3', returnPrompt: 'sce3 输出 miku', files: [] },
    ];
    // ① 上游都有输出 → 无标注。
    await runner.run(request(promptStep(), { previousOutputs, upstreamStepIds: ['sce3'] }));
    expect(textOf(subagents.continuableStarts[0]?.request.prompt[0])).not.toContain('上游未产出内容');

    // ② 声明的 inputFrom（path 形态）指向未执行的 step → 同样标注（默认上游与声明上游一视同仁）。
    const declared = { ...promptStep(), inputFrom: [{ id: 'ipt-1', path: 'sce2' }] };
    await runner.run(request(declared, { previousOutputs, upstreamStepNames: { sce2: 'sce2' } }));
    const declaredPrompt = textOf(subagents.continuableStarts[1]?.request.prompt[0]);
    expect(declaredPrompt).toContain('上游未产出内容');
    expect(declaredPrompt).toContain('sce2 (id: sce2)：本次未执行或输出为空，无可注入内容');
  });

  it('未声明 inputFrom 且无直接上游（Stage 首步）时不注入任何前置输出', async () => {
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
    ];
    await runner.run(request(promptStep(), { previousOutputs, upstreamStepIds: [] }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).not.toContain('前置Step: sce1');
    expect(promptText).toContain('用户原始需求');
  });

  it('同一前置 step 多段只注入一次（取最新段）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const previousOutputs = [
      { name: 'sce3', id: 'sce3', returnPrompt: 'sce3 第 1 段', files: [] },
      { name: 'sce1', id: 'sce1', returnPrompt: 'sce1 输出', files: [] },
      { name: 'sce3', id: 'sce3', returnPrompt: 'sce3 第 2 段', files: [] },
    ];

    await runner.run(request({ ...promptStep(), inputFrom: [{ path: 'sce3' }] }, { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('前置Step: sce3');
    expect(promptText).toContain('sce3 第 2 段');
    expect(promptText).not.toContain('sce3 第 1 段');
    expect(promptText).not.toContain('前置Step: sce1');
    // 恰好一块（不因多段而重复）。
    expect(promptText.split('前置Step: sce3').length - 1).toBe(1);
  });

  it('同一上游的**别名 id**（`sce3` 与 `sce3-<后缀>`）只注入一次（按上游 step 去重，不按原始 id）', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    // 真机形态（m15 全量跑出现 `前置Step: sce3` 两份）：同一步骤在快照里留下两个 id——
    // `idMatches` 明确允许 `sce3-<后缀>` 这类**循环别名 id**（`actualId.startsWith(targetId + '-')`），
    // 而 `previousOutputs` 的去重键是原始 id ⇒ 两个别名各注入一份、名字还都叫 sce3。
    const previousOutputs = [
      { name: 'sce3', id: 'sce3', returnPrompt: 'sce3 第 1 段', files: [] },
      { name: 'sce3', id: 'sce3-9f8e7d6c', returnPrompt: 'sce3 第 2 段（循环别名 id）', files: [] },
    ];

    await runner.run(request(promptStep(), { previousOutputs, upstreamStepIds: ['sce3'] }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 断言口径：**按上游 step 去重**（别名归并到同一上游）→ 恰好一块，且取最新段。
    expect(promptText.split('前置Step: sce3').length - 1, '同一上游（含别名 id）只注入一次').toBe(1);
    expect(promptText).toContain('sce3 第 2 段（循环别名 id）');
    expect(promptText).not.toContain('sce3 第 1 段');
  });

  it('声明 regex 时注入**提取后的片段**而不是整篇输出', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const previousOutputs = [
      { name: 'sce2', id: 'sce2', returnPrompt: '噪声\n版本号: v1.4.2\n噪声', files: [] },
    ];

    await runner.run(request({ ...promptStep(), inputFrom: [{ id: 'in-1', regex: '版本号: v[0-9.]+' }] }, { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('版本号: v1.4.2');
    expect(promptText).not.toContain('噪声');
  });

  it('参考信息体积护栏：超出预算时截断并标注', async () => {
    const { subagents, agents, runner } = harness({
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    const previousOutputs = [
      { name: 'big-1', id: 'big-1', returnPrompt: 'A'.repeat(12_000), files: [] },
      { name: 'big-2', id: 'big-2', returnPrompt: 'B'.repeat(12_000), files: [] },
    ];

    await runner.run(request({ ...promptStep(), inputFrom: [{ path: 'big-1' }, { path: 'big-2' }] }, { previousOutputs }));

    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('前置Step: big-1');
    expect(promptText).toContain('参考信息已截断');
    expect(promptText).not.toContain('前置Step: big-2');
    expect(promptText.length).toBeLessThan(40_000);
  });
});
