/**
 * workflow-engine.ts（SandoreEngineRuntime）的端到端集成测试：
 * 完整收尾阶段流转（finalizing → gating → routing → completed）+ 门禁失败分支。
 * @module @meiyukichan/dsh-sandore/workflow/src/workflow-engine-e2e
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime, TextBlock } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { FakeSessionTitle } from '../tests/mocks/session-title.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import { FakeWorkspace, FakeWorkspaceRegistry } from '../tests/mocks/workspace.ts';
import { SandoreEngineRuntime } from './index.ts';
import type { SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

/** UUID 正则（合成 sessionId 统一纯 UUID 格式）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 注册 workflow definition 到 persistence。 */
async function putDefinition(persistence: SandorePersistence, id: string, yaml: string): Promise<void> {
  const definition = parseWorkflowYaml(yaml);
  const createdAt = new Date().toISOString();
  await persistence.definitions.put(id, {
    yaml,
    name: definition.name,
    version: definition.version,
    createdAt,
    updatedAt: createdAt,
  });
}

/** 单 Stage + prompt step + 透传变量 + primary+secondary 双门禁工作流定义。 */
const e2ePhaseYaml = `id: wfl-e2e-phase
name: e2e-phase-test
version: "1.0.0"
stages:
  - id: stg-1
    name: 执行
    steps:
      - id: step-prompt
steps:
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "请输出项目名称：sandore"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
      secondary:
        enabled: true
        prompt: "请确认项目名称已正确输出"
`;

/** 组装集成测试 harness：注入内存 DSH 服务并加载引擎运行时。 */
async function harness(config: SandoreConfig = {}): Promise<{
  ctx: Context;
  engine: SandoreEngine;
  persistence: SandorePersistence;
  llm: FakeLlm;
  shell: FakeShell;
  sessions: FakeSessionStore;
  subagents: FakeSubagents;
  agents: FakeAgentRegistry;
  userQuestions: FakeUserQuestions;
  sessionTitle: FakeSessionTitle;
}> {
  const ctx = new Context();
  const storageDomain = new MemoryStorageDomain();
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
  await ctx.plugin(SandorePersistence);
  const persistence = ctx.sandorePersistence;

  const llm = new FakeLlm();
  const shell = new FakeShell();
  const sessions = new FakeSessionStore();
  const agents = new FakeAgentRegistry(sessions);
  const subagents = new FakeSubagents(ctx, (id) => agents.get(id));
  const subprocess = new FakeSubprocess();
  const userQuestions = new FakeUserQuestions();
  const sessionTitle = new FakeSessionTitle();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('userQuestions', userQuestions);
  ctx.provide('sessionTitle', sessionTitle);
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents, userQuestions, sessionTitle };
}

/** 等待实例到达 completed/failed 终态（以 sandore/end 为信号）。 */
function waitForEnd(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/end', () => resolve());
  });
}

describe('SandoreEngineRuntime e2e phase flow', () => {
  it('完整收尾阶段流转：finalizing → gating → routing → completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-e2e-phase', e2ePhaseYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, '项目名称：sandore');

    // 注册 FakeAgent child（prompt step 走 startContinuable 子代理）
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: '项目名称：sandore' }]));
    agents.register(child);
    // Phase C secondary 门禁经 startContinuable 建宿主可续接子代理（child-2）：预注册
    // FakeAgent 并回填门禁审查输出（gateStatus done）——门禁 AI 走子代理 agent loop。
    const gateChild = new FakeAgent('child-2');
    gateChild.session.append(assistantMessageEvent([{ type: 'text', text: '{"gateStatus":"done","gateDetail":"项目名称已正确输出"}' }]));
    agents.register(gateChild);

    // FakeLlm 响应序列：按消息内容分发
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      // Phase A assess（临时会话，ask 判定）——prompt 包含 hasAsk
      if (text.includes('hasAsk')) {
        return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
      }
      // Phase B assessForked（降级 llm.stream）——prompt 包含 compressedOutput
      if (text.includes('compressedOutput')) {
        return textChunks('{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"【任务要求】输出项目名称\\n【执行过程】直接输出\\n【最终成果】项目名称：sandore"}');
      }
      // 兜底
      return textChunks('');
    };

    // 收集 step-phase 事件
    const phaseEvents: Array<{ stepId: string; phase: string }> = [];
    ctx.on('sandore/step-phase', (...args: unknown[]) => {
      const stepId = args[1] as string;
      const phase = args[3] as string;
      phaseEvents.push({ stepId, phase });
    });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-e2e-phase', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 断言 1：完整事件序列（基础身份字段，从 state 的 Result 读一切详情）
    // 注：prompt step 走可续接子代理路径，Phase A assess 走 llm.stream，
    // Phase B assessForked 降级 llm.stream（child 无事件源），
    // Phase C secondary gate 经 startContinuable 子代理 settle 取输出。
    // 门禁通过后执行 Phase D routing，然后 completed。
    // 序列：[finalizing → gating → gating → routing → completed]
    expect(phaseEvents.map(e => e.phase)).toEqual([
      'finalizing',      // 收尾完成（assessForked 完成；降级路径无 running 中间态）
      'gating',          // 进入门禁（running 快照）
      'gating',          // 门禁完成（evaluateGates 通过）
      'routing',         // 进入路由（running 快照；routingResult 随 completed 写入）
      'completed',       // 最终完成
    ]);

    // 断言 2：从 state 的 Result 读取详情（用户原则：从 state 的 Result 读一切）
    const stepEntry = persistence.state.get(run.instanceId)!.executedSteps.find(s => s.stepId === 'step-prompt')!;
    expect(stepEntry.finalizeMeta?.currentPhase).toBe('completed');
    expect(stepEntry.finalizeMeta?.assessResult?.status).toBe('done');
    expect(stepEntry.finalizeMeta?.assessResult?.forkSessionId).toBeTruthy(); // 真实 UUID
    expect(stepEntry.finalizeMeta?.gateResult?.status).toBe('done');
    expect(stepEntry.finalizeMeta?.gateResult?.gateSessionId).toBe('child-2'); // 真实子代理 id（startContinuable）

    // 断言 3：透传变量提取
    expect(persistence.state.get(run.instanceId)!.passThroughVars['projectName']).toEqual({
      value: 'sandore',
      description: '项目名',
    });

    // 断言 4：step 状态
    expect(stepEntry.status).toBe('completed');
  });

  it('门禁失败分支：secondary gate 返回 failed → 事件序列正确 + 持久化正确', async () => {
    const { ctx, engine, persistence, llm, shell, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-e2e-phase', e2ePhaseYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, '项目名称：sandore');

    // 注册 FakeAgent child（prompt step 走 startContinuable 子代理）
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: '项目名称：sandore' }]));
    agents.register(child);
    // Phase C secondary 门禁经 startContinuable 建宿主可续接子代理（child-2）：预注册
    // FakeAgent 并回填门禁审查输出（gateStatus error——门禁失败分支）。
    const gateChild = new FakeAgent('child-2');
    gateChild.session.append(assistantMessageEvent([{ type: 'text', text: '{"gateStatus":"error","gateDetail":"项目名称不匹配"}' }]));
    agents.register(gateChild);

    // FakeLlm 响应序列：按消息内容分发（门禁失败）
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      // Phase A assess（临时会话，ask 判定）——prompt 包含 hasAsk
      if (text.includes('hasAsk')) {
        return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
      }
      // Phase B assessForked（降级 llm.stream）——prompt 包含 compressedOutput
      if (text.includes('compressedOutput')) {
        return textChunks('{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"【任务要求】输出项目名称\\n【执行过程】直接输出\\n【最终成果】项目名称：sandore"}');
      }
      // 兜底
      return textChunks('');
    };

    // 收集 step-phase 事件
    const phaseEvents: Array<{ stepId: string; phase: string }> = [];
    ctx.on('sandore/step-phase', (...args: unknown[]) => {
      const stepId = args[1] as string;
      const phase = args[3] as string;
      phaseEvents.push({ stepId, phase });
    });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-e2e-phase', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 断言 1：事件序列（基础身份字段，从 state 的 Result 读一切详情）
    // Round 17：降级路径无 onForkCreated，只有 1 个 finalizing(done)
    // 序列：[finalizing → gating → gating]
    expect(phaseEvents.map(e => e.phase)).toEqual([
      'finalizing',      // 收尾完成（assessForked 完成；降级路径无 running 中间态）
      'gating',          // 进入门禁（running 快照）
      'gating',          // 门禁失败（evaluateGates 不通过）
    ]);

    // 断言 2：从 state 的 Result 读取详情（用户原则：从 state 的 Result 读一切）
    const stepEntry = persistence.state.get(run.instanceId)!.executedSteps.find(s => s.stepId === 'step-prompt')!;
    expect(stepEntry.status).toBe('failed');
    expect(stepEntry.finalizeMeta?.assessResult?.status).toBe('done');
    expect(stepEntry.finalizeMeta?.gateResult?.gatesPassed).toBe(false);
    expect(stepEntry.finalizeMeta?.gateResult?.status).toBe('failed');
    expect(stepEntry.finalizeMeta?.currentPhase).toBe('gating');

    // 断言 3：实例状态
    expect(persistence.state.get(run.instanceId)!.status).toBe('failed');
  });
});
