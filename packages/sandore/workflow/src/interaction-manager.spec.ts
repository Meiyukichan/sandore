/**
 * interaction-manager.ts 的单元测试：引擎级 ask 主通道（登记 + 事件 + 卡片 await）、
 * pending Map 镜像持久化、replyQuestion/replyPermission 兼容路径与 unknown
 * requestId 报错、子代理 ask 标记块解析与转接、权限镜像（无自动审批）。
 * @module @deepseek-ai/dsh-sandore-workflow/src/interaction-manager.spec
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';

import { FakeAgent } from '../tests/mocks/agents.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import type { Agent } from '../../microflow/src/subagents.ts';
import {
  InteractionManager,
  parseDelegatedAsk,
  type InteractionManagerOptions,
  type PermissionReply,
} from './interaction-manager.ts';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionPayload,
  PendingPermissionEntry,
  PendingQuestionEntry,
} from './types.ts';

/** 构造一条 pending question 条目。 */
function questionEntry(requestId: string, payload: AskUserQuestionPayload): PendingQuestionEntry {
  return {
    id: requestId,
    stageId: 'stg-1',
    stepId: 'step-1',
    sessionId: 'inst-1',
    requestId,
    kind: 'question',
    status: 'pending',
    payload,
    createdAt: '2026-08-16T00:00:00.000Z',
  };
}

/** 构造一条 pending permission 条目。 */
function permissionEntry(requestId: string): PendingPermissionEntry {
  return {
    id: requestId,
    stageId: 'stg-1',
    stepId: 'step-1',
    sessionId: 'inst-1',
    requestId,
    kind: 'permission',
    status: 'pending',
    payload: { permission: 'write_file', patterns: ['/tmp/**'] },
    createdAt: '2026-08-16T00:00:00.000Z',
  };
}

/** 构造一个单题载荷（带选项）。 */
function singleQuestionPayload(): AskUserQuestionPayload {
  return {
    questions: [{
      id: 'q1',
      question: 'Which one?',
      options: [{ label: 'A' }, { label: 'B', description: 'second' }],
    }],
  };
}

/** 构造一个整批回答。 */
function answer(selected: string[]): AskUserQuestionAnswer {
  return { answers: [{ id: 'q1', selected }] };
}

/** 组装测试依赖（hostAgent + FakeUserQuestions + vi.fn 桩）。 */
function makeDeps(options?: { userQuestions?: FakeUserQuestions; hostAgent?: Agent }): {
  deps: InteractionManagerOptions;
  userQuestions: FakeUserQuestions;
  hostAgent: Agent;
  persist: ReturnType<typeof vi.fn>;
  emitQuestion: ReturnType<typeof vi.fn>;
  emitPermission: ReturnType<typeof vi.fn>;
  followup: ReturnType<typeof vi.fn>;
} {
  const userQuestions = options?.userQuestions ?? new FakeUserQuestions();
  const hostAgent = options?.hostAgent ?? new FakeAgent('host-1');
  const persist = vi.fn();
  const emitQuestion = vi.fn();
  const emitPermission = vi.fn();
  const followup = vi.fn(async () => {});
  const deps: InteractionManagerOptions = {
    hostAgent,
    userQuestions: () => userQuestions,
    persist,
    emitQuestion,
    emitPermission,
    followup,
  };
  return { deps, userQuestions, hostAgent, persist, emitQuestion, emitPermission, followup };
}

describe('InteractionManager.addPendingQuestion / addPendingPermission', () => {
  it('addPendingQuestion 登记即持久化（pending 条目）并发射 sandore/question', () => {
    const { deps, persist, emitQuestion, emitPermission } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = questionEntry('req-1', singleQuestionPayload());

    mgr.addPendingQuestion(entry);

    expect(persist).toHaveBeenCalledWith([entry]);
    expect(emitQuestion).toHaveBeenCalledWith(entry);
    expect(emitPermission).not.toHaveBeenCalled();
  });

  it('addPendingPermission 登记即持久化（pending 条目）并发射 sandore/permission', () => {
    const { deps, persist, emitPermission } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = permissionEntry('req-p');

    mgr.addPendingPermission(entry);

    expect(persist).toHaveBeenCalledWith([entry]);
    expect(emitPermission).toHaveBeenCalledWith(entry);
  });
});

describe('InteractionManager.ask（引擎级 ask 主通道）', () => {
  it('以 hostAgent 身份调用 userQuestions.ask，questions 对齐 AskUserQuestionItem（蛇形 multi_select → 驼峰 multiSelect）', async () => {
    const { deps, userQuestions, hostAgent } = makeDeps();
    const mgr = new InteractionManager(deps);
    const payload: AskUserQuestionPayload = {
      questions: [{
        id: 'q1',
        question: 'Which one?',
        header: 'Choice',
        options: [{ label: 'A' }],
        multi_select: true,
      }],
    };
    const entry = questionEntry('req-1', payload);
    const result = answer(['A']);
    userQuestions.answers.push(result);

    await expect(mgr.ask({ entry })).resolves.toEqual(result);

    expect(userQuestions.calls).toHaveLength(1);
    const request = userQuestions.calls[0]!;
    expect(request.agent).toBe(hostAgent);
    expect(request.questions).toEqual([{
      id: 'q1',
      question: 'Which one?',
      header: 'Choice',
      options: [{ label: 'A' }],
      multiSelect: true,
    }]);
  });

  it('卡片回复后条目终态化（status=replied + answer）并持久化', async () => {
    const { deps, userQuestions, persist } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = questionEntry('req-1', singleQuestionPayload());
    userQuestions.answers.push(answer(['A']));

    await mgr.ask({ entry });

    const lastCall = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as PendingQuestionEntry[];
    expect(lastCall).toEqual([{ ...entry, status: 'replied', answer: [['A']] }]);
  });

  it('无卡片通道时挂起，等待 replyQuestion 兼容路径 resolve（与 ask 的 await 汇合）', async () => {
    const { deps, persist } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = questionEntry('req-1', singleQuestionPayload());
    const result = answer(['A']);

    const asking = mgr.ask({ entry });
    await mgr.replyQuestion('req-1', result);
    await expect(asking).resolves.toEqual(result);

    const lastCall = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as PendingQuestionEntry[];
    expect(lastCall).toEqual([{ ...entry, status: 'replied', answer: [['A']] }]);
  });
});

describe('InteractionManager.replyQuestion', () => {
  it('未知 requestId 抛 SandoreError(INVALID_OPERATION)', async () => {
    const { deps } = makeDeps();
    const mgr = new InteractionManager(deps);

    await expect(mgr.replyQuestion('nope', answer(['A']))).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('已 replied 的 requestId 再次回复抛 SandoreError(INVALID_OPERATION)', async () => {
    const { deps, userQuestions } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = questionEntry('req-1', singleQuestionPayload());
    userQuestions.answers.push(answer(['A']));

    await mgr.ask({ entry });
    await expect(mgr.replyQuestion('req-1', answer(['A']))).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('InteractionManager.replyPermission', () => {
  it('reply=once/always 将条目置 replied 并持久化 answer', async () => {
    const { deps, persist } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = permissionEntry('req-p');
    mgr.addPendingPermission(entry);

    await mgr.replyPermission('req-p', 'always');

    const lastCall = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as PendingPermissionEntry[];
    expect(lastCall).toEqual([{ ...entry, status: 'replied', answer: 'always' }]);
  });

  it('reply=reject 将条目置 rejected 并持久化 answer', async () => {
    const { deps, persist } = makeDeps();
    const mgr = new InteractionManager(deps);
    const entry = permissionEntry('req-p');
    mgr.addPendingPermission(entry);

    await mgr.replyPermission('req-p', 'reject');

    const lastCall = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as PendingPermissionEntry[];
    expect(lastCall).toEqual([{ ...entry, status: 'rejected', answer: 'reject' }]);
  });

  it('未知 permission requestId 抛 SandoreError(INVALID_OPERATION)', async () => {
    const { deps } = makeDeps();
    const mgr = new InteractionManager(deps);

    await expect(mgr.replyPermission('nope', 'once' as PermissionReply)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('parseDelegatedAsk', () => {
  it('解析合法标记块返回载荷', () => {
    const text = '前置 [[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]] 后置';
    expect(parseDelegatedAsk(text)).toEqual({ questions: [{ id: 'q1', question: 'Q?' }] });
  });

  it('无标记块返回 undefined', () => {
    expect(parseDelegatedAsk('ordinary output')).toBeUndefined();
  });

  it('标记块 JSON 解析失败返回 undefined', () => {
    expect(parseDelegatedAsk('[[SANDORE_ASK]]not json[[/SANDORE_ASK]]')).toBeUndefined();
  });

  it('标记块 schema 校验不通过返回 undefined', () => {
    expect(parseDelegatedAsk('[[SANDORE_ASK]]{"questions":[{"id":123}]}[[/SANDORE_ASK]]')).toBeUndefined();
  });

  it('标记块 questions 为空返回 undefined（伪造标记块不转接）', () => {
    expect(parseDelegatedAsk('[[SANDORE_ASK]]{"questions":[]}[[/SANDORE_ASK]]')).toBeUndefined();
  });
});

describe('InteractionManager.delegateSubagentAsk', () => {
  it('子代理 final result 含合法标记块时转引擎级 ask 并 followup 注回答案', async () => {
    const { deps, userQuestions, followup, hostAgent } = makeDeps();
    const mgr = new InteractionManager(deps);
    const result = answer(['A']);
    userQuestions.answers.push(result);
    const output: ContentBlock[] = [{ type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Q?"}]}[[/SANDORE_ASK]]' }];

    const outcome = await mgr.delegateSubagentAsk({
      childId: 'child-1',
      output,
      stageId: 'stg-1',
      stepId: 'step-1',
      sessionId: 'inst-1',
    });

    expect(outcome).toEqual({ delegated: true });
    expect(userQuestions.calls[0]?.agent).toBe(hostAgent);
    expect(followup).toHaveBeenCalledWith('child-1', [{ type: 'text', text: JSON.stringify(result) }]);
  });

  it('无标记块按普通输出处理（不转接、不 followup）', async () => {
    const { deps, followup } = makeDeps();
    const mgr = new InteractionManager(deps);
    const output: ContentBlock[] = [{ type: 'text', text: 'ordinary output' }];

    const outcome = await mgr.delegateSubagentAsk({
      childId: 'child-1',
      output,
      stageId: 'stg-1',
      stepId: 'step-1',
      sessionId: 'inst-1',
    });

    expect(outcome).toEqual({ delegated: false });
    expect(followup).not.toHaveBeenCalled();
  });

  it('标记块 schema 校验不通过不转接（按普通输出处理）', async () => {
    const { deps, followup } = makeDeps();
    const mgr = new InteractionManager(deps);
    const output: ContentBlock[] = [{ type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":123}]}[[/SANDORE_ASK]]' }];

    const outcome = await mgr.delegateSubagentAsk({
      childId: 'child-1',
      output,
      stageId: 'stg-1',
      stepId: 'step-1',
      sessionId: 'inst-1',
    });

    expect(outcome).toEqual({ delegated: false });
    expect(followup).not.toHaveBeenCalled();
  });
});
