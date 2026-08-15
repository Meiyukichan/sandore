/**
 * subagents.ts 接缝（finalAssistantOutput + ctx.subagents/agents 类型）与三个测试桩
 * （subagents/agents/subprocess）的单元测试。
 * @module @deepseek-ai/dsh-sandore-microflow/src/subagents.spec
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { FinalizeMetaSchema } from '../../workflow/src/schema.ts';
import {
  FakeAgent,
  FakeAgentRegistry,
  assistantChunkEvent,
  assistantMessageEvent,
} from '../../workflow/tests/mocks/agents.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
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

describe('FinalizeMetaSchema', () => {
  it('accepts completionType/assessResult/gateResult', () => {
    const parsed = FinalizeMetaSchema.parse({
      status: 'completed',
      completionType: 'completed',
      assessResult: {
        completionType: 'completed',
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
    });
    expect(parsed.completionType).toBe('completed');
    expect(parsed.assessResult).toMatchObject({ forkSessionId: 'fork-1' });
    expect(parsed.gateResult).toMatchObject({ gatesPassed: true });
  });

  it('still parses legacy finalize meta without the three new fields', () => {
    const parsed = FinalizeMetaSchema.parse({ status: 'completed', sessionId: 's1' });
    expect(parsed.status).toBe('completed');
    expect(parsed.completionType).toBeUndefined();
    expect(parsed.assessResult).toBeUndefined();
    expect(parsed.gateResult).toBeUndefined();
  });
});
