/**
 * branch-evaluator.ts（BranchEvaluator + extractShouldExecute/extractBreakResult/
 * matchesExpectation + evaluateCondition 重试）的单元测试。
 *
 * 覆盖两阶段 start/collect/evaluate（agent 临时会话 + shell 直接执行）、shell 三注入
 * （透传替换/env/stdin）、条件分支 shouldExecute 两层解析、break 结果解析、分支匹配与
 * 条件分支 AI 路径解析失败重试（首轮 + follow-up 纠正，上限 MAX_BRANCH_EVAL_RETRIES）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/branch-evaluator.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime, TextBlock } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { FakeAgentRegistry } from '../../workflow/tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell, successResult } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { BranchEvaluator, extractBreakResult, extractShouldExecute, matchesExpectation } from './branch-evaluator.ts';
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

describe('extractShouldExecute', () => {
  it('returns true for JSON with shouldExecute true', () => {
    expect(extractShouldExecute('{"shouldExecute": true}')).toBe(true);
  });

  it('returns false for JSON with shouldExecute false', () => {
    expect(extractShouldExecute('{"shouldExecute": false}')).toBe(false);
  });

  it('returns true for a string shouldExecute "true"', () => {
    expect(extractShouldExecute('{"shouldExecute": "true"}')).toBe(true);
  });

  it('returns false for a string shouldExecute "false"', () => {
    expect(extractShouldExecute('{"shouldExecute": "false"}')).toBe(false);
  });

  it('extracts shouldExecute via case-insensitive regex for mixed output', () => {
    expect(extractShouldExecute('... {"shouldExecute": TRUE} ...')).toBe(true);
    expect(extractShouldExecute('前文 {"shouldExecute": FALSE} 后文')).toBe(false);
  });

  it('parses compact JSON without spaces and JSON with extra fields', () => {
    expect(extractShouldExecute('{"shouldExecute":true}')).toBe(true);
    expect(extractShouldExecute('{"other":1,"shouldExecute":false}')).toBe(false);
  });

  it('returns undefined when shouldExecute is absent or non-boolean', () => {
    expect(extractShouldExecute('{"foo": "bar"}')).toBeUndefined();
    expect(extractShouldExecute('{"shouldExecute": "maybe"}')).toBeUndefined();
    expect(extractShouldExecute('')).toBeUndefined();
  });

  it('returns undefined for a bare "true" without the shouldExecute JSON shape', () => {
    // 关键：裸 'true' 不再被判定为通过（与 buildBranchPrompt 要求的 JSON 格式对齐）。
    expect(extractShouldExecute('true')).toBeUndefined();
    expect(extractShouldExecute('  false  ')).toBeUndefined();
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
  it('matches an exact string expectation case-insensitively', () => {
    expect(matchesExpectation('lint-clean', 'lint-clean')).toBe(true);
    expect(matchesExpectation('LINT-CLEAN', 'lint-clean')).toBe(true);
    expect(matchesExpectation('lint-clean', 'lint-dirty')).toBe(false);
  });

  it('matches when the output contains the expectation (case-insensitive)', () => {
    expect(matchesExpectation('build succeeded: 100%', '100%')).toBe(true);
    expect(matchesExpectation('v1.2.3 released', 'v1.2.3')).toBe(true);
    expect(matchesExpectation('ALL GOOD', 'good')).toBe(true);
    expect(matchesExpectation('nothing here', 'absent')).toBe(false);
  });

  it('treats regex metacharacters as literals when no /.../ delimiter is present', () => {
    // 字面量含正则元字符（`\`、`%`、`.`、括号）但未用定界符 → 走包含匹配，
    // 不被旧 hasRegexMetacharacters 启发式误判为正则。
    expect(matchesExpectation('path is C:\dir\file', 'C:\dir\file')).toBe(true);
    expect(matchesExpectation('rate is (high)', '(high)')).toBe(true);
  });

  it('matches an explicit /regex/ expectation delimited by slashes', () => {
    expect(matchesExpectation('build-42', '/build-.*/')).toBe(true);
    expect(matchesExpectation('build-ok', '/build-(ok|pass)/')).toBe(true);
    expect(matchesExpectation('build-fail', '/^build-ok$/')).toBe(false);
  });

  it('returns false for an invalid explicit regex expectation', () => {
    expect(matchesExpectation('anything', '/[/')).toBe(false);
  });

  it('returns false for an undefined expectation', () => {
    expect(matchesExpectation('anything', undefined)).toBe(false);
  });
});

describe('BranchEvaluator two-phase', () => {
  it('runs an agent condition through a temp session with a non-null sessionHandle', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const partial = await evaluator.start(
      { type: 'agent', value: { promptText: 'check', providerId: 'p', modelId: 'm' } },
    );
    expect(partial.sessionHandle).not.toBeNull();
    expect(llm.calls).toHaveLength(1);

    const result = await evaluator.collect(partial);
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(result.sessionHandle).toBe(partial.sessionHandle);
  });

  it('evaluates an agent condition in one step via evaluate()', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const result = await evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } });
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(result.sessionHandle).not.toBeNull();
  });

  it('executes a shell condition directly with a null sessionHandle', async () => {
    const { shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');

    const result = await evaluator.evaluate(
      { type: 'shell', value: { command: 'echo lint-clean' } },
    );
    expect(shell.specs).toHaveLength(1);
    expect(result.sessionHandle).toBeNull();
    expect(result.output).toBe('lint-clean');
  });
});

describe('BranchEvaluator shell three-injection', () => {
  it('replaces passThroughVars in the command and injects them into the shell env', async () => {
    const { subprocess, shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'ok');

    await evaluator.evaluate(
      { type: 'shell', value: { command: 'echo ${projectName}' } },
      { passThroughVars: { projectName: 'sandore' } },
    );

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs[0]?.command).toBe('echo sandore');
    expect(shell.specs[0]?.env).toEqual({ projectName: 'sandore' });
  });

  it('writes the stdin content into the shell request', async () => {
    const { subprocess, shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'ok');

    await evaluator.evaluate(
      { type: 'shell', value: { command: 'node read-stdin.js' } },
      { stdin: '{"foo":"bar"}' },
    );

    expect(subprocess.specs).toHaveLength(0);
    expect(shell.specs[0]?.stdin).toBe('{"foo":"bar"}');
  });

  it('uses shell.run for a simple shell condition without injection', async () => {
    const { shell, subprocess, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'ok');

    const result = await evaluator.evaluate({ type: 'shell', value: { command: 'echo ok' } });

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

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'false' } })).rejects.toMatchObject({
      code: 'STEP_EXECUTION',
    });
    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'false' } })).rejects.toThrow(/boom/);
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

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } })).rejects.toMatchObject({
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

    await expect(evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } })).rejects.toMatchObject({
      code: 'STEP_EXECUTION',
    });
  });

  it('maps a shell nonzero exit to STEP_EXECUTION', async () => {
    const { subprocess, shell, evaluator } = harness();
    shell.runHandler = async spec => ({
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(
      evaluator.evaluate({ type: 'shell', value: { command: 'false' } }, { passThroughVars: { a: '1' } }),
    ).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
    expect(subprocess.specs).toHaveLength(0);
  });

  it('maps a shell timedOut to STEP_TIMEOUT', async () => {
    const { subprocess, shell, evaluator } = harness();
    shell.runHandler = async spec => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    });

    await expect(
      evaluator.evaluate({ type: 'shell', value: { command: 'sleep 10' } }, { passThroughVars: { a: '1' } }),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(subprocess.specs).toHaveLength(0);
  });
});

describe('BranchEvaluator provider/model fallback', () => {
  it('falls back to the directory provider/model at L3', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'dir-p', name: 'Directory Provider' });
    llm.models.set('dir-p', [{ provider: 'dir-p', id: 'dir-m', name: 'Directory Model' }]);
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    await evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } });

    expect(llm.calls[0]?.provider).toBe('dir-p');
    expect(llm.calls[0]?.model).toBe('dir-m');
  });

  it('throws STEP_EXECUTION when no LLM provider is available', async () => {
    const { evaluator } = harness();

    await expect(evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } })).rejects.toThrow(
      /no LLM provider available/,
    );
  });

  it('throws STEP_EXECUTION when a provider has no models', async () => {
    const { llm, evaluator } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });

    await expect(evaluator.evaluate({ type: 'prompt', value: { promptText: 'check' } })).rejects.toThrow(
      /no LLM model available for provider 'p'/,
    );
  });
});

describe('BranchEvaluator evaluateCondition retry', () => {
  it('returns valid shouldExecute on the first attempt without retry', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const result = await evaluator.evaluateCondition({ type: 'prompt', value: { promptText: 'check' } });

    expect(llm.calls).toHaveLength(1);
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(result.sessionHandle).not.toBeNull();
    expect(extractShouldExecute(result.output)).toBe(true);
  });

  it('retries with a follow-up when the first output is unparseable', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    const outputs = ['I cannot decide', '{"shouldExecute": true}'];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(outputs[callIndex++] ?? '');

    const result = await evaluator.evaluateCondition({ type: 'prompt', value: { promptText: 'check' } });

    // 首轮乱码不可解析 → 1 次 follow-up 纠正重试 → 第二轮返回合法 JSON。
    expect(llm.calls).toHaveLength(2);
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(extractShouldExecute(result.output)).toBe(true);

    // 重试调用为多轮：原始 user + 上一轮 assistant 输出 + 纠正 user follow-up。
    const retryMessages = llm.calls[1]?.messages ?? [];
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[0]?.role).toBe('user');
    expect(retryMessages[1]?.role).toBe('assistant');
    expect(retryMessages[2]?.role).toBe('user');
    const hintBlock = retryMessages[2]?.content[0] as TextBlock | undefined;
    expect(hintBlock?.text).toContain('shouldExecute');
  });

  it('gives up after MAX_BRANCH_EVAL_RETRIES and returns the last unparseable output', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('totally not json');

    const result = await evaluator.evaluateCondition({ type: 'prompt', value: { promptText: 'check' } });

    // 首轮 + 2 次重试 = 3 次 stream 调用；输出仍不可解析（调用方 decideCondition 兜底 false）。
    expect(llm.calls).toHaveLength(3);
    expect(result.output).toBe('totally not json');
    expect(extractShouldExecute(result.output)).toBeUndefined();
  });

  it('delegates a shell condition to evaluate without any LLM call', async () => {
    const { llm, shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');

    const result = await evaluator.evaluateCondition({ type: 'shell', value: { command: 'echo lint-clean' } });

    expect(llm.calls).toHaveLength(0);
    expect(shell.specs).toHaveLength(1);
    expect(result.sessionHandle).toBeNull();
    expect(result.output).toBe('lint-clean');
  });
});

describe('BranchEvaluator evaluateBreak (shouldBreak template)', () => {
  it('uses the dedicated shouldBreak template (not shouldExecute)', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('{"shouldBreak": true}');

    const result = await evaluator.evaluateBreak({ type: 'prompt', value: { promptText: 'check' } });

    expect(result.output).toBe('{"shouldBreak": true}');
    // 缺陷 4（fork-based 改造）：专用 shouldBreak 模板——要求返回 shouldBreak，不出现条件分支
    // 的 shouldExecute；不再手动传 I/O 文本（fork 会话注入全量历史，AI 自行可见循环体 I/O）。
    const prompt = llm.calls[0]?.messages[0]?.content[0] as TextBlock | undefined;
    expect(prompt?.text).toContain('shouldBreak');
    expect(prompt?.text).not.toContain('shouldExecute');
  });

  it('delegates a shell breakCondition to the shell runner without an LLM call', async () => {
    const { llm, shell, evaluator } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');

    const result = await evaluator.evaluateBreak({ type: 'shell', value: { command: 'echo lint-clean' } });

    // shell breakCondition 不消费 I/O 上下文（decideBreak 走 matchesExpectation）。
    expect(llm.calls).toHaveLength(0);
    expect(shell.specs).toHaveLength(1);
    expect(result.sessionHandle).toBeNull();
    expect(result.output).toBe('lint-clean');
  });
});

// ── Phase D 路由判断（fork 子代理机制：agents.create + seed + followup + dispose） ────

describe('BranchEvaluator Phase D 路由 fork 子代理机制', () => {
  /** 源子代理完整事件（turn 0 闭合）。 */
  function childEvents(): Array<{ type: string; seq: number; time: number; data: unknown }> {
    return [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
      { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant/message', seq: 2, time: 0, data: { turn: 0, step: 0, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'work output' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'completed' } } },
    ];
  }

  it('drives condition routing through a fork subagent (agents.create + seed + followup + whenIdle + dispose)', async () => {
    const { ctx, llm, agents, evaluator } = harnessWithAgents({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async childId => (childId === 'child-1' ? childEvents() : undefined),
    });
    agents.createFollowupHandler = () => [{ type: 'text', text: '{"shouldExecute": true}' }];

    const result = await evaluator.evaluateCondition(
      { type: 'prompt', value: { promptText: '判断分支' } },
      { stepSessionId: 'child-1', stepId: 'step-branch' },
    );

    // Phase D：agents.create 收到 seed = 完整事件 + meta（parentSession=宿主主代理、origin='subagent'）。
    expect(agents.createSeeds).toHaveLength(1);
    expect(agents.createSeeds[0]).toEqual(childEvents());
    expect(agents.createMetas[0]).toMatchObject({ parentSession: 'host-1', origin: 'subagent', seedLength: 4 });
    // sessionHandle = 路由子代理 id（纯 UUID）。
    expect(result.sessionHandle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.output).toBe('{"shouldExecute": true}');
    // followup 驱动一轮 + whenIdle + 评估完 dispose（live 移除、持久化保留）。
    const routingAgent = agents.createdAgents[agents.createdAgents.length - 1]!;
    expect(routingAgent.followups).toHaveLength(1);
    expect(routingAgent.whenIdleCount).toBe(1);
    expect(agents.get(result.sessionHandle)).toBeUndefined();
    // 路由子代理路径不消费 llm.stream（模型调用走 followup 驱动轮）。
    expect(llm.calls).toHaveLength(0);
  });

  it('follows up the same routing subagent with the correction hint on unparseable output', async () => {
    const { llm, agents, evaluator } = harnessWithAgents({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => childEvents(),
    });
    let call = 0;
    agents.createFollowupHandler = () => {
      call += 1;
      return call === 1 ? [{ type: 'text', text: 'not json' }] : [{ type: 'text', text: '{"shouldExecute": true}' }];
    };

    const result = await evaluator.evaluateCondition(
      { type: 'prompt', value: { promptText: '判断分支' } },
      { stepSessionId: 'child-1', stepId: 'step-branch' },
    );

    const routingAgent = agents.createdAgents[agents.createdAgents.length - 1]!;
    expect(routingAgent.followups).toHaveLength(2);
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(llm.calls).toHaveLength(0);
  });

  it('degrades to a temp llm.stream session when no fork config is provided (UUID handle, 不传历史)', async () => {
    const { llm, evaluator } = harness({ defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' });
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const result = await evaluator.evaluateCondition(
      { type: 'prompt', value: { promptText: '判断分支' } },
      { stepSessionId: 'child-1', stepId: 'step-branch' },
    );

    // 配置缺省 → fork 子代理不可用 → 降级一次性临时会话（纯 UUID 句柄，无历史注入）。
    expect(result.sessionHandle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.output).toBe('{"shouldExecute": true}');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.messages).toHaveLength(1);
  });

  it('degrades to a temp llm.stream session when the source has no events (synthetic session)', async () => {
    const { ctx, llm, agents, evaluator } = harnessWithAgents({
      hostAgentId: 'host-1',
      createAgent: options => agents.create(options),
      getStepSessionEvents: async () => undefined,
    });
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const result = await evaluator.evaluateCondition(
      { type: 'prompt', value: { promptText: '判断分支' } },
      { stepSessionId: 'step-sh-abcdef01', stepId: 'step-branch' },
    );

    expect(agents.createSeeds).toHaveLength(0);
    expect(result.sessionHandle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(llm.calls).toHaveLength(1);
  });

  /** 带 FakeAgentRegistry 的 harness（Phase D 路由 fork 配置：hostAgentId/createAgent/getStepSessionEvents）。 */
  function harnessWithAgents(config: BranchEvaluatorConfig): {
    ctx: Context;
    llm: FakeLlm;
    agents: FakeAgentRegistry;
    evaluator: BranchEvaluator;
  } {
    const fullConfig: BranchEvaluatorConfig = { defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm', ...config };
    const { ctx, llm } = harness(fullConfig);
    const agents = new FakeAgentRegistry();
    ctx.provide('agents', agents);
    return { ctx, llm, agents, evaluator: new BranchEvaluator(ctx, fullConfig) };
  }
});
