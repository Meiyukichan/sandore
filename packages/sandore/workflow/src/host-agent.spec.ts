/**
 * host-agent.ts（createHostAgentSetup 工厂）的单元测试：注册 8 个 sandore_* 工具、
 * 注入编排器 system prompt section、per-instance 闭包捕获、create/resume 共用同一
 * 工厂，以及宿主主代理创建的无自动 prompt 与 setup 抛错回滚语义。
 * @module @deepseek-ai/dsh-sandore-workflow/src/host-agent.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentSetupContext, PromptSection } from '../../microflow/src/subagents.ts';
import { FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import type { SandoreEngineSurface } from './engine-surface.ts';
import { createHostAgentSetup } from './host-agent.ts';
import type { DagInstanceState, DagRunStatus } from './types.ts';

/** 构造字段完整的 `DagInstanceState` 快照。 */
function makeState(status: DagRunStatus): DagInstanceState {
  return {
    taskId: 'inst-1',
    jobId: 'job-1',
    workflowId: 'wfl-1',
    status,
    originalInput: 'do it',
    currentStageId: '',
    executedSteps: [],
    stageInfos: [],
    pendingQueue: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

/** 构造一个用 `vi.fn` 打桩的引擎（满足 `SandoreEngineSurface` 结构面）。 */
function makeEngine(): SandoreEngineSurface {
  return {
    startInstance: vi.fn(async () => ({ instanceId: 'inst-new', status: 'running' as const })),
    recoverInstance: vi.fn(async () => ({ instanceId: 'inst-new', status: 'running' as const })),
    abortInstance: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    replyPermission: vi.fn(async () => {}),
    pauseStep: vi.fn(async () => {}),
    resumeStep: vi.fn(async () => {}),
    pauseAllSteps: vi.fn(async () => {}),
    resumeAllSteps: vi.fn(async () => {}),
    retryStep: vi.fn(async () => {}),
    getState: vi.fn(() => makeState('running')),
  };
}

/** 记录 `tools.register` / `systemPrompt.section` 调用的最小 agentCtx。 */
function makeRecordingContext(): {
  agentCtx: AgentSetupContext;
  tools: unknown[];
  sections: PromptSection[];
} {
  const tools: unknown[] = [];
  const sections: PromptSection[] = [];
  const agentCtx: AgentSetupContext = {
    tools: {
      register: (tool: unknown) => {
        tools.push(tool);
      },
    },
    systemPrompt: {
      section: (section: PromptSection) => {
        sections.push(section);
      },
    },
  };
  return { agentCtx, tools, sections };
}

/** 从注册的工具数组提取名称（非字符串名称归一为空串）。 */
function toolNames(tools: unknown[]): string[] {
  return tools.map((tool) => {
    const name = (tool as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
  });
}

describe('createHostAgentSetup', () => {
  it('registers 8 sandore_* tools and injects the orchestrator system prompt section', () => {
    const setup = createHostAgentSetup({ instanceId: 'inst-1', engine: makeEngine() });
    const { agentCtx, tools, sections } = makeRecordingContext();

    setup(agentCtx);

    expect(toolNames(tools)).toEqual([
      'sandore_getState',
      'sandore_startInstance',
      'sandore_abortInstance',
      'sandore_pauseStep',
      'sandore_resumeStep',
      'sandore_pauseAllSteps',
      'sandore_resumeAllPaused',
      'sandore_retryStep',
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe('sandore-host');
    expect(sections[0]?.order).toBe(116);
    expect(sections[0]?.text).toMatch(/sandore_/);
  });

  it('each tool closure captures the instanceId passed to the factory', async () => {
    const engine = makeEngine();
    const setup = createHostAgentSetup({ instanceId: 'inst-captured', engine });
    const { agentCtx, tools } = makeRecordingContext();
    setup(agentCtx);

    const getState = tools.find((tool) => (tool as { name?: unknown }).name === 'sandore_getState');
    expect(getState).toBeDefined();
    const execute = (getState as { execute(args: unknown, exec: unknown): Promise<unknown> }).execute;
    await execute({}, undefined);

    expect(engine.getState).toHaveBeenCalledWith('inst-captured');
  });

  it('produces identical registrations for create and resume (same params → same closure)', () => {
    const engine = makeEngine();
    const createSetup = createHostAgentSetup({ instanceId: 'inst-1', engine });
    const resumeSetup = createHostAgentSetup({ instanceId: 'inst-1', engine });

    const createCtx = makeRecordingContext();
    const resumeCtx = makeRecordingContext();
    createSetup(createCtx.agentCtx);
    resumeSetup(resumeCtx.agentCtx);

    expect(toolNames(createCtx.tools)).toEqual(toolNames(resumeCtx.tools));
    expect(createCtx.sections).toEqual(resumeCtx.sections);
  });
});

describe('host agent creation', () => {
  it('mints an idle agent (no auto prompt) with meta.cwd and runs setup exactly once', async () => {
    const sessions = new FakeSessionStore();
    const registry = new FakeAgentRegistry(sessions);
    const setup = createHostAgentSetup({ instanceId: 'inst-1', engine: makeEngine() });

    const handle = await registry.create({ sessionId: 'inst-1', meta: { cwd: '/srv/app' }, setup });

    expect(handle.agent.id).toBe('inst-1');
    expect(handle.agent.status).toBe('idle');
    expect(handle.agent.inbox.hasPending).toBe(false);
    expect(registry.createCwds).toEqual(['/srv/app']);
    expect(registry.setupCount).toBe(1);
    // 宿主 Session 已发布进 session store（引擎读回用于事件双发）。
    expect(sessions.get('inst-1')).toBeDefined();
  });

  it('rejects create when setup throws and leaves no agent or session registered', async () => {
    const sessions = new FakeSessionStore();
    const registry = new FakeAgentRegistry(sessions);
    registry.setupError = new Error('setup boom');

    const setup = createHostAgentSetup({ instanceId: 'inst-1', engine: makeEngine() });
    await expect(registry.create({ sessionId: 'inst-1', setup })).rejects.toThrow('setup boom');

    expect(registry.get('inst-1')).toBeUndefined();
    expect(sessions.get('inst-1')).toBeUndefined();
  });
});
