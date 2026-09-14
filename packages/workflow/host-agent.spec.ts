/**
 * host-agent.ts（createHostAgentSetup 工厂）的单元测试（§3.0：宿主主代理 = 纯 DSH
 * 默认主代理 + 模型选择装配）：setup 动作是「装 agent-scoped 模型选择 + 挂默认 agent
 * preset」（不注册任何 sandore_* 工具、不注入编排器角色提示词）、presets 服务缺失时
 * 跳过 mount、create/resume 共用同一工厂、宿主主代理创建的无自动 prompt 与 setup
 * 抛错回滚语义。
 *
 * 2026-09 架构修复回归面：宿主主代理必须自己跑 turn 去调 `sandore_workflow_run`，而
 * DSH `agent-loop/agent.ts:483-485` 在 provider/model 为空时直接抛
 * `agent "<id>" has no provider/model`——故本文件同时锁定 `resolveHostAgentOptions`
 * （基线路由）与 `installHostModelSelection`（scoped 模型选择）两条装配路径。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-agent.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentSetupContext } from '../microflow/subagents';
import { FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import {
  createHostAgentSetup,
  installHostModelSelection,
  resolveHostAgentOptions,
} from './host-agent.ts';

/** 构造最小 agentCtx（setup 不再注册工具/提示词，只需满足 AgentSetupContext 结构）。 */
function makeRecordingContext(options?: { on?: AgentSetupContext['on'] }): { agentCtx: AgentSetupContext } {
  const agentCtx: AgentSetupContext = {
    agent: { session: { append: () => undefined } },
    tools: { register: () => {} },
    systemPrompt: {
      section: () => {},
      context: () => () => {},
      getContextOrder: () => 70,
    },
    ...(options?.on === undefined ? {} : { on: options.on }),
  };
  return { agentCtx };
}

describe('createHostAgentSetup (§3.0 pure default preset)', () => {
  it('mounts the default agent preset via the injected presets seam and registers no sandore tools', async () => {
    const mount = vi.fn(async () => ({ id: 'default' }));
    const presets = { mount, resolve: vi.fn(async () => ({ id: 'default' })) };
    const setup = createHostAgentSetup({ instanceId: 'inst-1', presets });
    const { agentCtx } = makeRecordingContext();

    await setup(agentCtx);

    // 唯一动作：经注入的 presets 服务挂默认 preset（无 id = 默认），不注册任何工具。
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith(agentCtx);
  });

  it('skips mount when the presets seam is absent (no preset deployment)', async () => {
    const setup = createHostAgentSetup({ instanceId: 'inst-1' });
    const { agentCtx } = makeRecordingContext();

    await setup(agentCtx);

    // presets 缺失：跳过 mount 不抛错。
  });

  it('produces identical behavior for create and resume (same params → same closure)', async () => {
    const mount = vi.fn(async () => ({ id: 'default' }));
    const presets = { mount, resolve: vi.fn(async () => ({ id: 'default' })) };
    const createSetup = createHostAgentSetup({ instanceId: 'inst-1', presets });
    const resumeSetup = createHostAgentSetup({ instanceId: 'inst-1', presets });

    const createCtx = makeRecordingContext();
    const resumeCtx = makeRecordingContext();
    await createSetup(createCtx.agentCtx);
    await resumeSetup(resumeCtx.agentCtx);

    expect(mount).toHaveBeenCalledTimes(2);
  });
});

describe('宿主会话模型选择装配（架构修复：no provider/model → 宿主 turn 起不来）', () => {
  it('resolveHostAgentOptions maps currentSelection() to AgentOptions (with optional reasoningEffort)', () => {
    expect(resolveHostAgentOptions({
      defaults: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })).toEqual({ provider: 'p', model: 'm' });
    expect(resolveHostAgentOptions({
      defaults: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' as never }) },
    })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' });
  });

  it('resolveHostAgentOptions returns undefined when the agentDefaultModel service is absent', () => {
    // 最小桩部署/单测：不传 agentOptions（与修复前行为一致，但不抛错）。
    expect(resolveHostAgentOptions({})).toBeUndefined();
    expect(resolveHostAgentOptions({ projections: { stateOf: () => undefined } })).toBeUndefined();
  });

  it('resolveHostAgentOptions treats an empty provider/model as no route (never a fake route)', () => {
    expect(resolveHostAgentOptions({ defaults: { currentSelection: () => ({ provider: '', model: 'm' }) } })).toBeUndefined();
    expect(resolveHostAgentOptions({ defaults: { currentSelection: () => ({ provider: 'p', model: '' }) } })).toBeUndefined();
  });

  it('createHostAgentSetup installs the agent-scoped model selection (both scoped listeners)', async () => {
    const listeners: Array<{ name: string; handler: (...args: never[]) => unknown }> = [];
    const setup = createHostAgentSetup({
      instanceId: 'inst-1',
      defaults: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    });
    const { agentCtx } = makeRecordingContext({
      on: (name, handler) => { listeners.push({ name, handler }); return () => {}; },
    });

    await setup(agentCtx);

    // DSH `installModelSelection` 注册的两个 scoped waterfall 监听器：
    // ① system-prompt/assemble 快照选择；② agent/request 把选择写进请求 config。
    expect(listeners.map(entry => entry.name).sort()).toEqual(['agent/request', 'system-prompt/assemble']);
  });

  it('the installed selection overrides the request route with the default model (end-to-end through the two listeners)', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    installHostModelSelection(makeRecordingContext({
      on: (name, handler) => { listeners.set(name, handler); return () => {}; },
    }).agentCtx, { defaults: { currentSelection: () => ({ provider: 'chosen-provider', model: 'chosen-model' }) } });

    // ① assemble 先跑（快照 selection.current）；② request 再跑（把快照写进 config）。
    const assemble = listeners.get('system-prompt/assemble')!;
    const request = listeners.get('agent/request')!;
    await (assemble as unknown as (a: unknown, b: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
      {}, {}, async () => ({ variables: {} }),
    );
    const config = await (request as unknown as (a: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
      {}, async () => ({ provider: '', model: '', reasoningEffort: 'inherited' }),
    );
    expect(config).toEqual({ provider: 'chosen-provider', model: 'chosen-model' });
  });

  it('prefers the session model-selection projection (pending) over the deployment default', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    installHostModelSelection(makeRecordingContext({
      on: (name, handler) => { listeners.set(name, handler); return () => {}; },
    }).agentCtx, {
      defaults: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
      // 用户在会话里选了别的模型（DSH 客户端模型切换写 `model/selection` → 投影 pending）。
      projections: { stateOf: (_session, key) => (key === 'modelSelection' ? { pending: { provider: 'ui-p', model: 'ui-m' } } : undefined) },
    });

    const assemble = listeners.get('system-prompt/assemble')!;
    const request = listeners.get('agent/request')!;
    await (assemble as unknown as (a: unknown, b: unknown, next: () => Promise<unknown>) => Promise<unknown>)({}, {}, async () => ({}));
    const config = await (request as unknown as (a: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
      {}, async () => ({ provider: '', model: '' }),
    );
    expect(config).toEqual({ provider: 'ui-p', model: 'ui-m' });
  });

  it('ignores a malformed pending projection entry and keeps the default route', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    installHostModelSelection(makeRecordingContext({
      on: (name, handler) => { listeners.set(name, handler); return () => {}; },
    }).agentCtx, {
      defaults: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
      projections: { stateOf: () => ({ pending: { provider: '', model: null } }) },
    });

    const assemble = listeners.get('system-prompt/assemble')!;
    const request = listeners.get('agent/request')!;
    await (assemble as unknown as (a: unknown, b: unknown, next: () => Promise<unknown>) => Promise<unknown>)({}, {}, async () => ({}));
    const config = await (request as unknown as (a: unknown, next: () => Promise<unknown>) => Promise<unknown>)(
      {}, async () => ({ provider: '', model: '' }),
    );
    expect(config).toEqual({ provider: 'default-p', model: 'default-m' });
  });

  it('degrades without throwing when the agentCtx has no scoped on() (minimal mock context)', async () => {
    const { agentCtx } = makeRecordingContext();
    // 无 `on`：installModelSelection 抛错被吞为 warn，返回 no-op disposer（宿主仍可靠 agentOptions 起 turn）。
    const dispose = installHostModelSelection(agentCtx, { defaults: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
    expect(dispose).toBeTypeOf('function');
    dispose();
  });

  it('runs the selection install through the registry-backed setup (create path integration)', async () => {
    const sessions = new FakeSessionStore();
    const registry = new FakeAgentRegistry(sessions);
    const setup = createHostAgentSetup({
      instanceId: 'inst-1',
      defaults: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    });

    await registry.create({ sessionId: 'inst-1', setup });
    expect(registry.setupListeners.map(entry => entry.name).sort()).toEqual(['agent/request', 'system-prompt/assemble']);
  });
});

describe('host agent creation', () => {
  it('mints an idle agent (no auto prompt) with meta.cwd and runs setup exactly once', async () => {
    const sessions = new FakeSessionStore();
    const registry = new FakeAgentRegistry(sessions);
    const presets = { mount: vi.fn(async () => ({ id: 'default' })), resolve: vi.fn(async () => ({ id: 'default' })) };
    const setup = createHostAgentSetup({ instanceId: 'inst-1', presets });

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

    const presets = { mount: vi.fn(async () => ({ id: 'default' })), resolve: vi.fn(async () => ({ id: 'default' })) };
    const setup = createHostAgentSetup({ instanceId: 'inst-1', presets });
    await expect(registry.create({ sessionId: 'inst-1', setup })).rejects.toThrow('setup boom');

    expect(registry.get('inst-1')).toBeUndefined();
    expect(sessions.get('inst-1')).toBeUndefined();
  });
});
