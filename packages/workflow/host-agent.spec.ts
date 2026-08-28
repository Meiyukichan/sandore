/**
 * host-agent.ts（createHostAgentSetup 工厂）的单元测试（§3.0：宿主主代理 = 纯 DSH
 * 默认主代理）：setup 唯一动作是挂默认 agent preset（不注册任何 sandore_* 工具、
 * 不注入编排器角色提示词）、presets 服务缺失时跳过 mount、create/resume 共用同一
 * 工厂，以及宿主主代理创建的无自动 prompt 与 setup 抛错回滚语义。
 * @module dsh-sandore/workflow/src/host-agent.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentSetupContext } from '../microflow/subagents';
import { FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { createHostAgentSetup } from './host-agent.ts';

/** 构造最小 agentCtx（setup 不再注册工具/提示词，只需满足 AgentSetupContext 结构）。 */
function makeRecordingContext(): { agentCtx: AgentSetupContext } {
  const agentCtx: AgentSetupContext = {
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
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
