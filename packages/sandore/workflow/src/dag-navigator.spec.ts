/**
 * dag-navigator.ts（WorkflowDagNavigator）的单元测试：Stage 级条件分支评估。
 *
 * 直接单测 tryAdvanceStage 评估 Stage branch.condition 选下一 Stage（修前盲取首
 * Stage 目标）。覆盖：多条件分支批量评估（A 命中→Stage A、B 命中→Stage B，AI 条件
 * 一次批量调用返回 branchId 数组）、无命中数组顺序兜底、无 condition 默认分支、
 * StageContract 注入评估 context、shell 匹配 label、未完成/末位 Stage 边界。Step 级
 * 路由已迁 microflow（本导航器只持 Stage 图）。
 * @module @deepseek-ai/dsh-sandore-workflow/src/dag-navigator.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { WorkflowDagNavigator } from './dag-navigator.ts';
import type { WorkflowDefinition, WorkflowStage } from './schema.ts';
import type { StageContract } from './types.ts';

/** 组装测试 ctx（FakeLlm + FakeShell，Stage 条件评估非 fork——一次性会话）。 */
function makeCtx(): { ctx: Context; llm: FakeLlm; shell: FakeShell } {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  llm.providers.push({ id: 'p', name: 'Provider' });
  llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('fs', {});
  return { ctx, llm, shell };
}

/** 构造已完成 StageContract（isStageAllDone 判定 status === 'completed'）。 */
function doneContract(stageId: string, stageName: string, artifactPrompt?: string): StageContract {
  return {
    stageId,
    stageName,
    status: 'completed',
    artifacts: artifactPrompt === undefined
      ? []
      : [{ stepId: 'step-x', outputToId: 'out', files: [], returnPrompt: artifactPrompt }],
    passThroughVars: {},
    contractArtifacts: {},
    completedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 构造 Stage（可选 branches）。 */
function stage(id: string, name: string, branches?: WorkflowStage['branches']): WorkflowStage {
  return { id, name, steps: [{ id: `${id}-step` }], ...(branches === undefined ? {} : { branches }) };
}

/** 构造工作流定义（stages + 顶层 steps 占位）。 */
function makeDef(stages: WorkflowStage[]): WorkflowDefinition {
  return {
    id: 'wfl', name: 'wfl', version: '1', stages,
    steps: stages.flatMap(s => s.steps.map<WorkflowDefinition['steps'][number]>(stp => ({ id: stp.id }))),
    settings: {},
  };
}

/** 取 llm 首次调用的首条用户消息文本（单 text block）。 */
function firstPromptText(llm: FakeLlm): string {
  const content = llm.calls[0]?.messages[0]?.content;
  if (content === undefined) {
    return '';
  }
  for (const block of content) {
    if (block.type === 'text') {
      return block.text;
    }
  }
  return '';
}

/** 新建导航器并把 currentStage 标记完成（setStageContract）。 */
function makeNavigator(ctx: Context, stages: WorkflowStage[], currentStageId: string, contract?: StageContract): WorkflowDagNavigator {
  const def = makeDef(stages);
  const nav = new WorkflowDagNavigator(def, ctx, { defaultTimeoutMs: 60000 }, '/tmp', {
    currentStageId,
    ...(contract === undefined ? {} : { stageContracts: { [currentStageId]: contract } }),
  });
  return nav;
}

describe('WorkflowDagNavigator Stage 级条件分支评估', () => {
  // 四 Stage：entry → [condA→stg-a, condB→stg-b, default→stg-default]；stageOrder = [entry, a, b, default]。
  // 数组下一 of entry = stg-a；条件目标 stg-a/stg-b/default 与数组顺序区分开。
  const branchesWithDefault = [
    { condition: { type: 'prompt', value: { promptText: 'go-a?' } }, next: 'stg-a' },
    { condition: { type: 'prompt', value: { promptText: 'go-b?' } }, next: 'stg-b' },
    { next: 'stg-default' },
  ];
  const branchesNoDefault = [
    { condition: { type: 'prompt', value: { promptText: 'go-a?' } }, next: 'stg-a' },
    { condition: { type: 'prompt', value: { promptText: 'go-b?' } }, next: 'stg-b' },
  ];
  const fourStages = [
    stage('stg-entry', '入口', branchesWithDefault),
    stage('stg-a', 'A'),
    stage('stg-b', 'B'),
    stage('stg-default', '默认'),
  ];

  it('条件 A 命中 → 推进到 Stage A', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-a"]}');
    const nav = makeNavigator(ctx, fourStages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    expect(nav.currentNodeId).toBe('stg-a');
  });

  it('批量评估：条件 A false、条件 B 命中 → 推进到 Stage B（一次调用，非数组顺序 stg-a）', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-b"]}');
    const nav = makeNavigator(ctx, fourStages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    // 第二个条件命中 → stg-b（不是数组顺序的 stg-a，证明按 condition 选）。
    expect(nav.currentNodeId).toBe('stg-b');
    // AI 条件一次批量调用（对齐 branch-evaluate-batch），不逐条调用。
    expect(llm.calls).toHaveLength(1);
    // 批量提示词含两个分支的 branchId + executeCondition。
    const promptText = firstPromptText(llm);
    expect(promptText).toContain('"branchId": "stg-a"');
    expect(promptText).toContain('"branchId": "stg-b"');
    expect(promptText).toContain('"executeCondition": "go-a?"');
    expect(promptText).toContain('"executeCondition": "go-b?"');
  });

  it('全条件 false 且无默认分支 → 数组顺序兜底', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": []}');
    const stages = [
      stage('stg-entry', '入口', branchesNoDefault),
      stage('stg-a', 'A'),
      stage('stg-b', 'B'),
    ];
    const nav = makeNavigator(ctx, stages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    // 两条件均不命中且无默认 → 数组顺序下一 stg-a。
    expect(nav.currentNodeId).toBe('stg-a');
  });

  it('全条件 false 有默认分支（无 condition）→ 走默认 Stage（非数组顺序）', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": []}');
    const nav = makeNavigator(ctx, fourStages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    // 两条件均不命中 → 第三分支无 condition（默认）→ stg-default（非数组顺序 stg-a）。
    expect(nav.currentNodeId).toBe('stg-default');
  });

  it('评估基于 StageContract：AI 提示词含当前 Stage 契约内容（stage 名/产物）', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-a"]}');
    const nav = makeNavigator(
      ctx,
      [stage('stg-entry', '入口Stage', [{ condition: { type: 'prompt', value: { promptText: 'go-a?' } }, next: 'stg-a' }]), stage('stg-a', 'A')],
      'stg-entry',
      doneContract('stg-entry', '入口Stage', '产物: 报告'),
    );
    await nav.tryAdvanceStage();
    // StageContract 摘要注入 AI 提示词：含 stage 名与产物 returnPrompt（<ReferenceInfo> 内）。
    const promptText = firstPromptText(llm);
    expect(promptText).toContain('入口Stage');
    expect(promptText).toContain('产物: 报告');
    expect(promptText).toContain('<ReferenceInfo>');
    expect(promptText).toContain('<Reference title="当前 Stage 完成契约">');
  });

  it('shell condition stdout 匹配 label → 命中该分支', async () => {
    const { ctx, shell } = makeCtx();
    shell.runHandler = async spec => successResult(spec, 'ok');
    const stages = [
      stage('stg-entry', '入口', [{ condition: { type: 'shell', value: { command: 'echo ok' } }, label: 'ok', next: 'stg-a' }, { next: 'stg-default' }]),
      stage('stg-a', 'A'),
      stage('stg-default', '默认'),
    ];
    const nav = makeNavigator(ctx, stages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    expect(nav.currentNodeId).toBe('stg-a');
    // StageContract 摘要作 stdin 注入 shell。
    expect(shell.requests[0]?.stdin).toContain('入口');
  });

  it('shell condition stdout 不匹配 label → 跳过，走默认分支', async () => {
    const { ctx, shell } = makeCtx();
    shell.runHandler = async spec => successResult(spec, 'no');
    const stages = [
      stage('stg-entry', '入口', [{ condition: { type: 'shell', value: { command: 'echo no' } }, label: 'ok', next: 'stg-a' }, { next: 'stg-default' }]),
      stage('stg-a', 'A'),
      stage('stg-default', '默认'),
    ];
    const nav = makeNavigator(ctx, stages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    expect(nav.currentNodeId).toBe('stg-default');
  });

  it('未完成 Stage（无 completed 契约）→ 不推进，返回 false', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-a"]}');
    const nav = makeNavigator(ctx, fourStages, 'stg-entry');
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(false);
    expect(nav.currentNodeId).toBe('stg-entry');
    // 未完成 → 不评估条件（无 llm 调用）。
    expect(llm.calls).toHaveLength(0);
  });

  it('末位 Stage 完成 → 无下一 Stage，返回 false', async () => {
    const { ctx, llm } = makeCtx();
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-a"]}');
    const nav = makeNavigator(ctx, fourStages, 'stg-default', doneContract('stg-default', '默认'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(false);
    expect(nav.currentNodeId).toBe('stg-default');
  });

  it('无 branches → 数组顺序兜底到下一 Stage', async () => {
    const { ctx, llm } = makeCtx();
    const stages = [stage('stg-entry', '入口'), stage('stg-a', 'A')];
    const nav = makeNavigator(ctx, stages, 'stg-entry', doneContract('stg-entry', '入口'));
    const advanced = await nav.tryAdvanceStage();
    expect(advanced).toBe(true);
    expect(nav.currentNodeId).toBe('stg-a');
    // 无 branches → 不评估条件。
    expect(llm.calls).toHaveLength(0);
  });
});
