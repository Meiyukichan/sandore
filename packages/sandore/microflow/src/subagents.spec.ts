/**
 * subagents.ts 接缝（finalAssistantOutput + ctx.subagents/agents 类型）与三个测试桩
 * （subagents/agents/subprocess）的单元测试。
 * @module @deepseek-ai/dsh-sandore-microflow/src/subagents.spec
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { FinalizeMetaSchema } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import {
  FakeAgent,
  FakeAgentRegistry,
  assistantChunkEvent,
  assistantMessageEvent,
} from '../../workflow/tests/mocks/agents.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
import { FakeSessionStore } from '../../workflow/tests/mocks/sessions.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { finalAssistantOutput } from './subagents.ts';
import type { Agent, ContinuableStartSpec } from './subagents.ts';

/** 组装一个可续接子代理启动规格。 */
function continuableSpec(parent: Agent): ContinuableStartSpec {
  return {
    provider: 'mock',
    label: 'test child',
    request: { prompt: [{ type: 'text', text: 'do the work' }], parent },
    signal: new AbortController().signal,
  };
}

describe('finalAssistantOutput', () => {
  it('returns undefined for empty events', () => {
    expect(finalAssistantOutput([])).toBeUndefined();
  });

  it('returns the last non-empty assistant message content blocks', () => {
    const events = [
      assistantMessageEvent([{ type: 'text', text: 'hello' }]),
      assistantChunkEvent('noise'),
    ];
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('accumulates text-delta chunks when no assistant message exists', () => {
    const events = [assistantChunkEvent('hello'), assistantChunkEvent(' world')];
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('prefers the later non-empty message over earlier messages', () => {
    const events = [
      assistantMessageEvent([{ type: 'text', text: 'first' }]),
      assistantMessageEvent([{ type: 'text', text: 'second' }]),
    ];
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('ignores an empty assistant message', () => {
    const events = [
      assistantMessageEvent([{ type: 'text', text: 'first' }]),
      assistantMessageEvent([]),
    ];
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'first' }]);
  });
});

describe('capability seams injectable via ctx.provide', () => {
  it('injects subagents and startContinuable returns childId on inbox acceptance', async () => {
    const ctx = new Context();
    const subagents = new FakeSubagents();
    ctx.provide('subagents', subagents);

    const started = await ctx.subagents.startContinuable(continuableSpec(new FakeAgent('parent-1')));
    expect(started.childId).toBe('child-1');
    expect(started.messageId).toBe('msg-1');
    expect(subagents.continuableStarts).toHaveLength(1);
  });

  it('injects agents and resolves get/create/resume', async () => {
    const ctx = new Context();
    const agents = new FakeAgentRegistry();
    ctx.provide('agents', agents);

    const created = await ctx.agents.create({ sessionId: 'agent-1' });
    expect(created.agent.id).toBe('agent-1');
    expect(ctx.agents.get('agent-1')).toBe(created.agent);
    const resumed = await ctx.agents.resume({ resumeSessionId: 'agent-1' });
    expect(resumed.agent.id).toBe('agent-1');
  });

  it('injects subprocess and resolves resolveExecutable/spawn', async () => {
    const ctx = new Context();
    const subprocess = new FakeSubprocess();
    ctx.provide('subprocess', subprocess);

    const resolved = await ctx.subprocess.resolveExecutable('node');
    expect(resolved).toBe('/usr/bin/node');
    const handle = ctx.subprocess.spawn({
      argv: ['node', '--version'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 5000,
    });
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
  });
});

describe('FakeAgentRegistry setup replay', () => {
  it('executes the setup callback and records meta.cwd on create', async () => {
    const registry = new FakeAgentRegistry();
    const seen: string[] = [];
    const handle = await registry.create({
      sessionId: 'agent-1',
      meta: { cwd: '/srv/app' },
      setup: (agentCtx) => {
        agentCtx.tools.register({ name: 'sandore_getState' });
        seen.push('setup');
      },
    });
    expect(handle.agent.id).toBe('agent-1');
    expect(registry.createCwds).toEqual(['/srv/app']);
    expect(registry.setupCount).toBe(1);
    expect(seen).toEqual(['setup']);
  });

  it('executes the setup callback on resume', async () => {
    const registry = new FakeAgentRegistry();
    await registry.create({ sessionId: 'agent-1' });
    const seen: string[] = [];
    await registry.resume({
      resumeSessionId: 'agent-1',
      setup: () => {
        seen.push('resume-setup');
      },
    });
    expect(registry.setupCount).toBe(1);
    expect(seen).toEqual(['resume-setup']);
  });
});

describe('FakeSubagents lifecycle state machine', () => {
  it('tracks startContinuable → interrupt → followup and lists children', async () => {
    const subagents = new FakeSubagents();
    const parent = new FakeAgent('parent-1');
    const started = await subagents.startContinuable(continuableSpec(parent));
    expect(started.childId).toBe('child-1');
    expect(subagents.childStatus('child-1')).toBe('running');

    subagents.interrupt('child-1', { kind: 'ancestor', agent: parent });
    expect(subagents.childStatus('child-1')).toBe('interrupted');

    const children = await subagents.listChildren('parent-1');
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'child', id: 'child-1', activity: 'inactive' });

    await subagents.followup(parent, 'child-1', [{ type: 'text', text: 'resume' }], {
      source: { kind: 'model', provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    });
    expect(subagents.childStatus('child-1')).toBe('running');
  });
});

describe('FakeSessionStore fork', () => {
  it('forks an inclusive prefix of source events into a new session', () => {
    const store = new FakeSessionStore();
    const source = store.create('source-1');
    source.append('sandore/start', { taskId: 't1' });
    source.append('sandore/step-start', { stepId: 's1' });
    source.append('sandore/step-completed', { stepId: 's1' });

    const forked = store.fork('source-1', 1, 'fork-1');
    expect(forked.events).toHaveLength(2);
    expect(forked.events[0]?.type).toBe('sandore/start');
    expect(forked.events[1]?.type).toBe('sandore/step-start');
    expect(store.get('fork-1')).toBe(forked);
  });
});

describe('FinalizeMetaSchema', () => {
  it('accepts currentPhase/assessResult/gateResult', () => {
    const parsed = FinalizeMetaSchema.parse({
      currentPhase: 'completed',
      assessSessionId: 'fork-1',
      assessResult: {
        passThroughVars: { projectName: 'sandore' },
        forkSessionId: 'fork-1',
        assessmentRaw: 'raw',
      },
      gateResult: {
        gatesPassed: true,
        primaryPassed: true,
        gateSessionId: 'gate-1',
        assessmentRaw: 'raw',
      },
      gateSessionId: 'gate-1',
    });
    expect(parsed.currentPhase).toBe('completed');
    // Round 17：顶层 assessSessionId/gateSessionId 已删除，sessionId 从 Result 内读
    expect(parsed.assessSessionId).toBeUndefined();
    expect(parsed.gateSessionId).toBeUndefined();
    expect(parsed.assessResult).toMatchObject({ forkSessionId: 'fork-1' });
    expect(parsed.gateResult).toMatchObject({ gatesPassed: true });
  });

  it('parses a minimal finalize meta without the optional fields', () => {
    const parsed = FinalizeMetaSchema.parse({ currentPhase: 'ask-detect' });
    expect(parsed.currentPhase).toBe('ask-detect');
    expect(parsed.assessSessionId).toBeUndefined();
    expect(parsed.assessResult).toBeUndefined();
    expect(parsed.gateResult).toBeUndefined();
    // 旧字段（status/sessionId/completionType）已删除：zod 默认 strip 未知键。
    expect((parsed as { status?: unknown }).status).toBeUndefined();
  });
});
