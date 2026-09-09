/**
 * stage-executor.ts（StageExecutor）的单元测试：段模型核心不变量。
 *
 * 覆盖 §3.3–§3.5 定夺的段创建规则：
 * - executedSteps 条目的 `id` 为纯 UUID，且每次执行段唯一（同 Stage 内两个 Step
 *   各自新 id）
 * - `sessionMeta.childId`（子代理占位/真实会话 id）与段 `id` **解耦**（互不相等、
 *   语义分离）
 * - 命令节点段携带 `createdAt` 与 `attemptIndex: 0`（时间轴排序键）
 * - pause 续跑（resumePendingPaused）基于旧段**新建段对象**：新 id + attemptIndex+1
 *   + createdAt，旧 paused 段保持定格快照
 * @module @meiyukichan/dsh-sandore/microflow/src/stage-executor.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '../workflow/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeShell } from '../tests/mocks/shell.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import type { ConcurrencyLimiter } from './concurrency-limiter.ts';
import { FinalizeManager } from './finalize-manager.ts';
import type { FinalizeManagerConfig } from './finalize-manager.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome } from './file-utils.ts';
import type { LoopState } from './loop-manager.ts';
import { StageExecutor } from './stage-executor.ts';
import type { StageExecutorOptions, StageExecutorResume } from './stage-executor.ts';
import { StepNavigator } from './step-navigator.ts';
import type { StepRunnerConfig } from './step-runner.ts';
import type { SubagentSettlement, SubagentStopReason } from './subagents.ts';

/** 纯 UUID 形状（8-4-4-4-12 十六进制）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 内存文件系统（target 导向两段式协议）：与 file-utils.spec / finalize-manager.spec 一致。 */
class FakeFs implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  seedFile(path: string, content = ''): void {
    this.files.set(path, content);
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      this.dirs.add(segments.slice(0, i).join('/'));
    }
  }

  async resolve(path: string): Promise<FsTarget> {
    const normalized = path.replace(/\/+$/, '') || '/';
    return { targetKey: normalized, displayPath: normalized };
  }

  processPath(target: FsTarget): string {
    return target.displayPath;
  }

  async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const prefix = target.targetKey === '/' ? '' : `${target.targetKey}/`;
    const names = new Set<string>();
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) {
        const name = dir.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    return [...names].sort().map(name => {
      const full = prefix + name;
      const isDir = this.dirs.has(full);
      return { name, type: isDir ? 'directory' : 'file', target: { targetKey: full, displayPath: full } };
    });
  }

  async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.targetKey);
    if (content === undefined) throw new Error(`FS_NOT_FOUND: ${target.displayPath}`);
    return content;
  }

  async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null;
    this.seedFile(target.targetKey, content);
    return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content };
  }
}

/** 组装一个单 Stage 工作流定义（shell Step，无门禁/无透传变量 → finalize 直接 done）。 */
function singleShellDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage; step: WorkflowStep } {
  const step: WorkflowStep = {
    id: 'step-sh',
    name: 'echo',
    command: { type: 'shell', value: { command: 'echo hi' } },
  };
  const stage: WorkflowStage = {
    id: 'stg-1',
    name: 'Stage 1',
    steps: [{ id: 'step-sh' }],
  };
  const definition: WorkflowDefinition = {
    id: 'wfl-1',
    name: 'wfl-1',
    version: '1',
    stages: [stage],
    steps: [step],
    settings: {},
  };
  return { definition, stage, step };
}

/** 组装 StageExecutor 测试环境。 */
function harness(): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  subagents: FakeSubagents;
  subprocess: FakeSubprocess;
  fs: FakeFs;
  agents: FakeAgentRegistry;
  makeExecutor: (options?: Partial<StageExecutorOptions>, finalizeConfig?: FinalizeManagerConfig) => StageExecutor;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subagents = new FakeSubagents();
  const subprocess = new FakeSubprocess();
  const fs = new FakeFs();
  const agents = new FakeAgentRegistry();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subagents', subagents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('sessions', {} as unknown as SessionStore);
  ctx.provide('agents', agents);
  ctx.provide('fs', fs as unknown as FileSystem);

  const makeExecutor = (options?: Partial<StageExecutorOptions>, finalizeConfig?: FinalizeManagerConfig): StageExecutor => {
    const { definition, stage } = singleShellDefinition();
    const stageDef = options?.stageDef ?? stage;
    const workflowDef = options?.workflowDef ?? definition;
    const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
    // Step 级路由已归 microflow：用真实 StepNavigator（持当前 Stage Step 节点图 + 循环管理器），
    // 不再经 options 注入 resolveNextNodes。
    const stepNavigator = new StepNavigator(ctx, { defaultTimeoutMs: 60000 }, loopState, stageDef, workflowDef);
    const loopManager = stepNavigator.loopManagerInstance;
    const config: FinalizeManagerConfig = {
      defaultTimeoutMs: 60000,
      defaultProvider: 'p',
      defaultModel: 'm',
      ...(finalizeConfig ?? {}),
    };
    const finalizeManager = new FinalizeManager(ctx, config);
    const runnerConfig: StepRunnerConfig = {
      defaultTimeoutMs: 60000,
      ...(options?.runnerConfig === undefined ? {} : options.runnerConfig),
    };
    return new StageExecutor({
      ctx,
      stageDef,
      workflowDef,
      input: { originalInput: 'do it', contractArtifacts: {}, passThroughVars: {} },
      sharedState: { cwd: '/tmp', taskId: 'task-1' },
      runnerConfig,
      loopManager,
      stepNavigator,
      finalizeManager,
      ...(options?.hooks === undefined ? {} : { hooks: options.hooks }),
      ...(options?.concurrencyLimiter === undefined ? {} : { concurrencyLimiter: options.concurrencyLimiter }),
      visitCounts: {},
      ...(options?.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
      // visitCounts 注入透传（崩溃恢复测试需要播种快照计数；缺省空对象）。
      ...(options?.visitCounts === undefined ? {} : { visitCounts: options.visitCounts }),
      onPersist: options?.onPersist ?? (async () => {}),
      ...(options?.commitState === undefined ? {} : { commitState: options.commitState }),
    });
  };

  return { ctx, llm, shell, subagents, subprocess, fs, agents, makeExecutor };
}

describe('StageExecutor 段模型不变量', () => {
  it('shell Step 执行产生的段 id 为纯 UUID', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    expect(result.executedSteps).toHaveLength(1);
    const segment = result.executedSteps[0]!;
    expect(segment.id).toMatch(UUID_RE);
  });

  it('同 Stage 两个 Step 各自生成唯一段 id（每次执行段唯一）', async () => {
    const { definition, stage } = singleShellDefinition();
    // 扩展为两个 shell Step。
    const secondStep: WorkflowStep = {
      id: 'step-sh2',
      name: 'echo2',
      command: { type: 'shell', value: { command: 'echo again' } },
    };
    const multiStage: WorkflowStage = {
      ...stage,
      steps: [{ id: 'step-sh' }, { id: 'step-sh2' }],
    };
    const multiDefinition: WorkflowDefinition = {
      ...definition,
      stages: [multiStage],
      steps: [...(definition.steps ?? []), secondStep],
    };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: spec.command, stderr: '' });

    // 真实 StepNavigator 路由：两 Step 均无 branches → 数组顺序兜底，
    // step-sh 解析下一批 → step-sh2，step-sh2 无后续 → 停止。
    const executor = makeExecutor({
      stageDef: multiStage,
      workflowDef: multiDefinition,
    });
    const result = await executor.execute();

    expect(result.executedSteps).toHaveLength(2);
    const ids = result.executedSteps.map(segment => segment.id);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toMatch(UUID_RE);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sessionMeta.childId 与段 id 解耦（合成占位 ≠ 执行段 id）', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    const segment = result.executedSteps[0]!;
    // shell 为合成会话：childId 是 step-{stepId}-{hex} 占位，与段 id（UUID）不同。
    expect(segment.sessionMeta?.synthetic).toBe(true);
    expect(segment.sessionMeta?.childId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(segment.sessionMeta?.childId).not.toBe(segment.id);
  });

  it('命令节点段携带 createdAt 与 attemptIndex: 0（时间轴排序键）', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    const segment = result.executedSteps[0]!;
    expect(segment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(segment.attemptIndex).toBe(0);
  });

  it('崩溃恢复/重试续跑（resumeFrom）从指定子代理 Step 播种，跳过已完成 Step', async () => {
    const { definition, stage } = singleShellDefinition();
    const agentStep: WorkflowStep = {
      id: 'step-sh',
      name: 'agent',
      command: { type: 'agent', value: { promptText: 'do work' } },
    };
    const completed: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-1',
      stepId: 'step-sh',
      stageId: 'stg-1',
      name: 'agent',
      status: 'completed',
      command: { type: 'agent', value: { promptText: 'do work' } },
      sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
      visitCount: 1,
      createdAt: '2026-08-16T00:00:00.000Z',
      attemptIndex: 0,
      output: [{ type: 'text', text: 'first' }],
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [completed],
      resumeSubagents: [{
        step: agentStep,
        executed: { ...completed, id: 'exec-2', status: 'running', attemptIndex: 1, createdAt: '2026-08-16T00:00:01.000Z' },
        childId: 'child-1',
      }],
    };
    const { agents, makeExecutor } = harness();
    // 注册续跑的子代理（whenIdle 后取 final output）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    agents.register(child);

    const executor = makeExecutor({
      stageDef: stage,
      workflowDef: definition,
      resumeFrom,
    });
    const result = await executor.execute();

    // 播种：completed 段进 executedSteps 快照（不重跑），续跑段完成后并入。
    expect(result.status).toBe('completed');
    expect(result.executedSteps.some(segment => segment.id === 'exec-1')).toBe(true);
    expect(result.executedSteps.some(segment => segment.id === 'exec-2')).toBe(true);
  });

  it('between-steps 崩溃续跑（resumeBetweenSteps）从最后完成 Step 反推 DAG next，不重跑已完成 Step（缺陷 9 G）', async () => {
    const { definition, stage } = singleShellDefinition();
    // 两步线性 shell Stage：step-a → step-b（无 branches，数组顺序兜底 next）。
    const stepA: WorkflowStep = { id: 'step-a', name: 'a', command: { type: 'shell', value: { command: 'echo a' } } };
    const stepB: WorkflowStep = { id: 'step-b', name: 'b', command: { type: 'shell', value: { command: 'echo b' } } };
    const twoStepStage: WorkflowStage = { ...stage, steps: [{ id: 'step-a' }, { id: 'step-b' }] };
    const twoStepDef: WorkflowDefinition = { ...definition, stages: [twoStepStage], steps: [stepA, stepB] };
    // 崩溃前 step-a 已完成落盘、step-b 未执行（between-steps 窗口）：无活跃段。
    const completedA: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-a',
      stepId: 'step-a',
      stageId: 'stg-1',
      name: 'a',
      status: 'completed',
      command: { type: 'shell', value: { command: 'echo a' } },
      sessionMeta: { childId: 'step-a-synthetic', synthetic: true, command: 'shell' },
      visitCount: 1,
      createdAt: '2026-08-16T00:00:00.000Z',
      attemptIndex: 0,
      output: [{ type: 'text', text: 'a' }],
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [completedA],
      resumeBetweenSteps: true,
    };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: spec.command, stderr: '' });

    const executor = makeExecutor({ stageDef: twoStepStage, workflowDef: twoStepDef, resumeFrom });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // step-a 不重跑：仅 'exec-a' 一段（无新增 step-a 段 → 非恰好一次语义成立）。
    const stepASegments = result.executedSteps.filter(segment => segment.stepId === 'step-a');
    expect(stepASegments).toHaveLength(1);
    expect(stepASegments[0]?.id).toBe('exec-a');
    // step-b 续跑一次（从 step-a 反推 DAG next 播种 batch，新增段完成）。
    const stepBSegments = result.executedSteps.filter(segment => segment.stepId === 'step-b');
    expect(stepBSegments).toHaveLength(1);
    expect(stepBSegments[0]?.status).toBe('completed');
  });
});

/** 提取文本 ContentBlock 的纯文本（非文本块返回空串）。 */
function textOf(block: ContentBlock | undefined): string {
  return block !== undefined && block.type === 'text' ? block.text : '';
}

describe('StageExecutor 缺陷 7：解析并注入任务规则', () => {
  /** 组装带三级 rules 的 prompt Step 工作流定义。 */
  function rulesDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage } {
    const step: WorkflowStep = {
      id: 'step-p',
      name: 'review',
      command: { type: 'prompt', value: { promptText: '生成报告' } },
      rules: ['chinese-output'],
    };
    const stage: WorkflowStage = {
      id: 'stg-1',
      name: 'Stage 1',
      steps: [{ id: 'step-p' }],
      rules: ['no-direct-commit'],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-1',
      name: 'wfl-1',
      version: '1',
      settings: {},
      stages: [stage],
      steps: [step],
      rules: {
        'chinese-output': '所有输出必须使用中文',
        'no-direct-commit': '禁止直接执行 git commit',
        'unused-rule': '未引用的规则',
      },
    };
    return { definition, stage };
  }

  it('processCommandNode 解析 3 级合并 rules 并经 StepRunRequest 注入提示词 ## 任务规则', async () => {
    const { definition, stage } = rulesDefinition();
    const { llm, subagents, agents, makeExecutor } = harness();
    // prompt Step 走可续接子代理（决策 D3）：provider/model 走 llm 目录（L3）兜底，
    // 注册真实 childId 并回填最终输出。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'report content' }]));
    agents.register(child);

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // startContinuable 的请求提示词应含 ## 任务规则 节，且内容为 step.rules ∪
    // stage.rules 去重后查 workflow.rules。
    expect(subagents.continuableStarts).toHaveLength(1);
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 任务规则');
    expect(promptText).toContain('- **chinese-output**: 所有输出必须使用中文');
    expect(promptText).toContain('- **no-direct-commit**: 禁止直接执行 git commit');
    // 未引用的规则键不出现在提示词中
    expect(promptText).not.toContain('unused-rule');
  });

  it('workflow/stage/step 全无 rules 时不注入 ## 任务规则 节（向后兼容）', async () => {
    const { definition, stage } = singleShellDefinition();
    // singleShellDefinition 是 shell Step（无 AI 提示词），改造成 prompt Step 验证不注入。
    const promptStep: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'prompt', value: { promptText: 'do work' } },
    };
    const promptDef: WorkflowDefinition = {
      ...definition,
      steps: [promptStep],
    };
    const { llm, subagents, agents, makeExecutor } = harness();
    // prompt Step 走可续接子代理：provider/model 走 llm 目录（L3）兜底，注册真实 childId。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);

    const executor = makeExecutor({ stageDef: stage, workflowDef: promptDef });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    // 头部三点列表含 `` `## 任务规则` `` 引用（行内反引号），此处断言正文节不注入。
    expect(promptText).not.toContain('\n## 任务规则\n');
  });
});

// ── 缺陷 16：collectStepArtifacts 产物收集（四处断裂修复） ──────────────────────

describe('StageExecutor 缺陷 16：collectStepArtifacts 产物收集', () => {
  /** 组装带 outputTo（glob + 非 glob + regex 三项）的 shell Step 工作流定义。 */
  function outputToDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage; step: WorkflowStep } {
    const step: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'shell', value: { command: 'echo hi' } },
      outputTo: [
        { id: 'literal', path: 'out/report.md' },
        { id: 'glob', path: 'out/*.md' },
        { id: 'regex', regex: 'out/.+\\.md$' },
      ],
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'Stage 1', steps: [{ id: 'step-sh' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-1', name: 'wfl-1', version: '1', settings: {}, stages: [stage], steps: [step],
    };
    return { definition, stage, step };
  }

  // 功能点 ①：StageContract.artifacts[].files 与 contractArtifacts 非空（收集生效）
  it('finalizeStageContract 收集产物填 artifacts[].files 并聚合 contractArtifacts（缺陷 16）', async () => {
    const { definition, stage } = outputToDefinition();
    const { fs, shell, makeExecutor } = harness();
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'hi', stderr: '' });
    fs.seedFile('/tmp/out/report.md');
    fs.seedFile('/tmp/out/notes.md');

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    const contract = result.stageContract;
    // 三个 outputTo 项各一个 artifacts 条目（files 非硬编码 []）
    expect(contract.artifacts).toHaveLength(3);
    const filesById = new Map(contract.artifacts.map(a => [a.outputToId, a.files] as const));
    // 非 glob 字面路径：fileExists 精确命中 report.md
    expect(filesById.get('literal')).toEqual(['/tmp/out/report.md']);
    // glob：out/*.md 命中 notes.md + report.md
    expect(filesById.get('glob')!.sort()).toEqual(['/tmp/out/notes.md', '/tmp/out/report.md']);
    // regex：out/.+\.md$ 命中 notes.md + report.md
    expect(filesById.get('regex')!.sort()).toEqual(['/tmp/out/notes.md', '/tmp/out/report.md']);
    // contractArtifacts 按 outputTo.id 聚合（非硬编码 {}）
    expect(contract.contractArtifacts['literal']).toEqual(['/tmp/out/report.md']);
    expect(contract.contractArtifacts['glob']!.sort()).toEqual(['/tmp/out/notes.md', '/tmp/out/report.md']);
    expect(contract.contractArtifacts['regex']!.sort()).toEqual(['/tmp/out/notes.md', '/tmp/out/report.md']);
  });

  // 功能点 ① 边界：无 outputTo 的 Step 不产生 artifacts 条目
  it('finalizeStageContract 跳过无 outputTo 的 Step（artifacts 为空，contractArtifacts 为空）', async () => {
    const { definition, stage } = singleShellDefinition();
    const { shell, makeExecutor } = harness();
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.stageContract.artifacts).toEqual([]);
    expect(result.stageContract.contractArtifacts).toEqual({});
  });

  // 功能点 ②：finalize 评估提示词 <artifacts> 块含当前 Step 产物（context.artifacts 填充）
  it('finalize 评估提示词 <artifacts> 块含当前 Step 产物（缺陷 16；primary 门禁零 AI）', async () => {
    // Round 20：shell 步骤跳过 Phase A/B 收尾评估（无 assess 提示词）——本用例改用
    // prompt Step（非 shell）验证 Phase B 提示词仍含 <artifacts> 块。
    const { definition, stage } = singleShellDefinition();
    const stepWithGates: WorkflowStep = {
      id: 'step-sh',
      name: 'agent',
      command: { type: 'prompt', value: { promptText: 'do work' } },
      outputTo: [{ id: 'report', path: 'out/report.md' }],
      passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      gates: { primary: { enabled: true } },
    };
    const def: WorkflowDefinition = { ...definition, steps: [stepWithGates] };
    const { llm, fs, agents, makeExecutor } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"completionType":"completed","passThroughVars":{}}');
    // prompt Step 走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work output' }]));
    agents.register(child);
    fs.seedFile('/tmp/out/report.md');

    const executor = makeExecutor({ stageDef: stage, workflowDef: def });
    const result = await executor.execute();

    // prompt 无 prompt stream → calls = [Phase A assess, Phase B 重新 assess（无 fork
    // 配置降级临时会话）]；primary 门禁为纯代码产物校验（零 AI）——不再有第 3 次门禁
    // AI 调用，产物存在即通过。
    expect(result.status).toBe('completed');
    expect(llm.calls).toHaveLength(2);
    // Phase B 重新评估提示词同样含 <Artifacts> 块（缺陷 16：收尾评估上下文带产物）。
    const phaseBAssessPrompt = textOf(llm.calls[1]?.messages[0]?.content[0]);
    expect(phaseBAssessPrompt).toContain('<Artifacts>');
    expect(phaseBAssessPrompt).toContain('/tmp/out/report.md');
  });

  // 功能点 ③：toPreviousOutput files 非空（前置产物 <artifacts> 块）
  it('toPreviousOutput 收集产物填前置 Step 提示词 <artifacts> 块（缺陷 16）', async () => {
    const { definition, stage } = singleShellDefinition();
    const stepA: WorkflowStep = {
      id: 'step-a', name: 'produce',
      command: { type: 'shell', value: { command: 'echo done' } },
      outputTo: [{ id: 'report', path: 'out/report.md' }],
    };
    const stepB: WorkflowStep = {
      id: 'step-b', name: 'consume',
      command: { type: 'prompt', value: { promptText: 'review previous' } },
    };
    const twoStepStage: WorkflowStage = { ...stage, steps: [{ id: 'step-a' }, { id: 'step-b' }] };
    const twoStepDef: WorkflowDefinition = { ...definition, stages: [twoStepStage], steps: [stepA, stepB] };
    const { llm, subagents, shell, fs, agents, makeExecutor } = harness();
    // prompt Step（step-b）走可续接子代理：provider/model 走 llm 目录（L3）兜底，
    // 注册真实 childId 并回填最终输出。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'done', stderr: '' });
    fs.seedFile('/tmp/out/report.md');

    const executor = makeExecutor({ stageDef: twoStepStage, workflowDef: twoStepDef });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // step-a 是 shell（无 AI 调用）；step-b 是 prompt（startContinuable 提示词含前置产物）。
    // step-b 无 gates 无未解析透传变量 → finalize 跳过 → 无 assess/gate stream。
    expect(subagents.continuableStarts).toHaveLength(1);
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('的输出和产物');
    expect(promptText).toContain('<Artifacts>');
    expect(promptText).toContain('/tmp/out/report.md');
  });

  // 功能点 ③ 续跑路径：resumeFrom 的 completedSteps 重建 previousOutputs 时收集产物
  it('resumeFrom 续跑路径 initState 收集 completedSteps 产物 + StageContract 收集续跑 executedSteps 产物（缺陷 16）', async () => {
    const { definition, stage } = singleShellDefinition();
    const agentStep: WorkflowStep = {
      id: 'step-sh', name: 'agent',
      command: { type: 'agent', value: { promptText: 'do work' } },
      outputTo: [{ id: 'report', path: 'out/report.md' }],
    };
    const completed: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-1', stepId: 'step-sh', stageId: 'stg-1', name: 'agent', status: 'completed',
      command: { type: 'agent', value: { promptText: 'do work' } },
      sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
      outputTo: [{ id: 'report', path: 'out/report.md' }],
      visitCount: 1, createdAt: '2026-08-16T00:00:00.000Z', attemptIndex: 0,
      output: [{ type: 'text', text: 'first' }],
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [completed],
      resumeSubagents: [{
        step: agentStep,
        executed: { ...completed, id: 'exec-2', status: 'running', attemptIndex: 1, createdAt: '2026-08-16T00:00:01.000Z' },
        childId: 'child-1',
      }],
    };
    const { llm, fs, agents, makeExecutor } = harness();
    // 注册续跑的子代理（whenIdle 后取 final output）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    agents.register(child);
    fs.seedFile('/tmp/out/report.md');

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, resumeFrom });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // initState resumeFrom 分支收集 completedSteps 产物填 previousOutputs.files（不崩），
    // 续跑段（exec-2）完成后并入 executedSteps；finalizeStageContract 对 executedSteps
    // 收集产物：exec-1 与 exec-2 都声明同一 outputTo（report），各产生一个 artifacts 条目。
    const contract = result.stageContract;
    expect(contract.artifacts).toHaveLength(2);
    expect(contract.artifacts[0]!.stepId).toBe('step-sh');
    expect(contract.artifacts[0]!.outputToId).toBe('report');
    expect(contract.artifacts[0]!.files).toEqual(['/tmp/out/report.md']);
    expect(contract.artifacts[1]!.stepId).toBe('step-sh');
    expect(contract.artifacts[1]!.outputToId).toBe('report');
    expect(contract.artifacts[1]!.files).toEqual(['/tmp/out/report.md']);
    // contractArtifacts 按 outputTo.id 聚合两个 executedStep 的产物（合并）。
    expect(contract.contractArtifacts).toEqual({ report: ['/tmp/out/report.md', '/tmp/out/report.md'] });
  });
});

// ── 缺陷 10：队列驱动真并发改造（runLoop 并发 + maxConcurrentSteps 生效） ──────

/** 并行分支定义：step-router 有两个并行 branches（无 condition），step-a + step-b 并行后汇聚到 step-end。 */
function parallelBranchDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage } {
  const stepRouter: WorkflowStep = { id: 'step-router', name: 'Router' };
  const stepA: WorkflowStep = { id: 'step-a', name: 'A', command: { type: 'shell', value: { command: 'echo a' } } };
  const stepB: WorkflowStep = { id: 'step-b', name: 'B', command: { type: 'shell', value: { command: 'echo b' } } };
  const stepEnd: WorkflowStep = { id: 'step-end', name: 'End', command: { type: 'shell', value: { command: 'echo end' } } };
  const stage: WorkflowStage = {
    id: 'stg-1',
    name: 'Parallel',
    // step-a/step-b 各自显式 branches 指向 step-end（汇聚），避免 arrayNextStep 隐式
    // 边导致 step-a → step-b → step-a 无限循环（并行场景 arrayNext 不适用）。
    steps: [
      { id: 'step-router', branches: [{ next: 'step-a' }, { next: 'step-b' }] },
      { id: 'step-a', branches: [{ next: 'step-end' }] },
      { id: 'step-b', branches: [{ next: 'step-end' }] },
      { id: 'step-end' },
    ],
  };
  const definition: WorkflowDefinition = {
    id: 'wfl-parallel', name: 'wfl-parallel', version: '1', settings: {}, stages: [stage],
    steps: [stepRouter, stepA, stepB, stepEnd],
  };
  return { definition, stage };
}

/** 跟踪并发上限的测试用 limiter（记录 acquire 时 max active 数）。 */
class TrackingLimiter implements ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  maxObserved = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      this.maxObserved = Math.max(this.maxObserved, this.active);
      return;
    }
    // hand-off：release() 调用 resolve 转移槽位（active 不变，不需要 await 后递增）。
    await new Promise<void>(resolve => { this.waiters.push(resolve); });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
      return;
    }
    this.active -= 1;
  }
}

describe('StageExecutor 缺陷 10：队列驱动真并发改造', () => {
  // ① 并行分支并发执行（Promise.all，不再逐个串行）
  it('parallel branches execute concurrently (Promise.all, not serial)', async () => {
    const { definition, stage } = parallelBranchDefinition();
    const { shell, makeExecutor } = harness();
    // shell handler 带 yield 让并发可观测：active > 1 时说明并发执行。
    let active = 0;
    let maxActive = 0;
    shell.runHandler = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve(); // yield to event loop → 允许其他并发 shell 启动
      active -= 1;
      return { exitCode: 0, stdout: 'done', stderr: '' };
    };

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    expect(result.executedSteps).toHaveLength(4); // router + step-a + step-b + step-end
    // 无 limiter（unlimited）→ 两 step-a/step-b shell handler 并发执行 → maxActive ≥ 2。
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });

  // ② maxConcurrentSteps 上限生效（并发数 ≤ maxConcurrentSteps）
  it('maxConcurrentSteps limits concurrency (max active ≤ limit)', async () => {
    const { definition, stage } = parallelBranchDefinition();
    const { shell, makeExecutor } = harness();
    let active = 0;
    let maxActive = 0;
    shell.runHandler = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { exitCode: 0, stdout: 'done', stderr: '' };
    };

    // limiter max=1 → 串行（不并发）
    const limiter = new TrackingLimiter(1);
    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, concurrencyLimiter: limiter });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // limiter maxObserved 应 ≤ 1（step-a/step-b 不并发）。
    expect(limiter.maxObserved).toBe(1);
    // shell handler 也应观察到 maxActive = 1（串行执行）。
    expect(maxActive).toBe(1);
  });

  // ⑥ 串行模型回归（maxConcurrentSteps=1 时行为与改造前一致）
  it('serial regression: maxConcurrentSteps=1 executes steps in order (like before)', async () => {
    const { definition, stage } = parallelBranchDefinition();
    const { shell, makeExecutor } = harness();
    const executionOrder: string[] = [];
    let active = 0;
    let maxActive = 0;
    shell.runHandler = async spec => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      executionOrder.push(spec.command);
      await Promise.resolve();
      active -= 1;
      return { exitCode: 0, stdout: spec.command, stderr: '' };
    };

    const limiter = new TrackingLimiter(1);
    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, concurrencyLimiter: limiter });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    expect(result.executedSteps).toHaveLength(4); // router + step-a + step-b + step-end
    // 串行执行：maxActive = 1（无并发）
    expect(maxActive).toBe(1);
    expect(limiter.maxObserved).toBe(1);
  });

  // ④ 嵌套循环计数并发安全（外层重入内层时内层 visitCount 从 0 起）
  it('nested loop visitCount resets on outer re-entry (counting model safe under concurrency)', async () => {
    // 构建 2 层嵌套循环：outer(3) → inner(3) → body → (body 回边 inner) → inner 跳出 → outer → 重复
    // outer maxIterations=3（第 3 次 visit 跳出 → 跑 2 轮 inner，每轮 body 2 次 = 4 次）。
    // inner maxIterations=3（第 3 次 visit 跳出 → 跑 2 次 body）。
    const stepOuter: WorkflowStep = { id: 'step-outer-loop', name: 'Outer' };
    const stepInner: WorkflowStep = { id: 'step-inner-loop', name: 'Inner' };
    const stepBody: WorkflowStep = { id: 'step-body', name: 'Body', command: { type: 'shell', value: { command: 'echo body' } } };
    const stage: WorkflowStage = {
      id: 'stg-1', name: 'Nested',
      steps: [
        { id: 'step-outer-loop', branches: [{ loop: { next: 'step-inner-loop', exitTo: '', maxIterations: 3 } }] },
        { id: 'step-inner-loop', branches: [{ loop: { next: 'step-body', exitTo: 'step-outer-loop', maxIterations: 3 } }] },
        // step-body 显式回边 step-inner-loop（否则 arrayNextStep 为空 → 不回边 → inner 跑 1 次即停）。
        { id: 'step-body', branches: [{ next: 'step-inner-loop' }] },
      ],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-nested', name: 'wfl-nested', version: '1', settings: {}, stages: [stage],
      steps: [stepOuter, stepInner, stepBody],
    };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'body', stderr: '' });

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // outer 2 轮 × inner 2 次 = body 执行 4 次。
    const bodySteps = result.executedSteps.filter(s => s.stepId === 'step-body');
    expect(bodySteps).toHaveLength(4);
    // 循环控制节点（纯 loop 分支无 command）平时不产生路由条目（仅 breakCondition
    // 评估跳出时回写 loopMeta），因此 executedSteps 可能不含 step-outer-loop/inner-loop。
    // 但 visitCount 反映循环计数正确（body 4 次证明 outer 2 轮 × inner 2 次）。
  });
});

// ── 补充 37：SessionIdleWaiter 多 child 并发（Promise.all(whenIdle)） ──────────

/** 并行分支定义（agent 子代理版）：两个并行 agent Step 汇聚到 step-end。 */
function parallelAgentDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage } {
  const stepRouter: WorkflowStep = { id: 'step-router', name: 'Router' };
  const stepA: WorkflowStep = { id: 'step-a', name: 'A', command: { type: 'agent', value: { promptText: 'do A' } } };
  const stepB: WorkflowStep = { id: 'step-b', name: 'B', command: { type: 'agent', value: { promptText: 'do B' } } };
  const stepEnd: WorkflowStep = { id: 'step-end', name: 'End', command: { type: 'shell', value: { command: 'echo end' } } };
  const stage: WorkflowStage = {
    id: 'stg-1',
    name: 'ParallelAgent',
    steps: [
      { id: 'step-router', branches: [{ next: 'step-a' }, { next: 'step-b' }] },
      { id: 'step-a', branches: [{ next: 'step-end' }] },
      { id: 'step-b', branches: [{ next: 'step-end' }] },
      { id: 'step-end' },
    ],
  };
  const definition: WorkflowDefinition = {
    id: 'wfl-parallel-agent', name: 'wfl-parallel-agent', version: '1', settings: {}, stages: [stage],
    steps: [stepRouter, stepA, stepB, stepEnd],
  };
  return { definition, stage };
}

describe('StageExecutor 补充 37：SessionIdleWaiter 多 child 并发', () => {
  it('multiple agent subagents run concurrently (Promise.all(whenIdle) aggregated at runLoop)', async () => {
    const { definition, stage } = parallelAgentDefinition();
    const { llm, subagents, shell, agents, makeExecutor } = harness();
    // agent step 的 runAgentStep 需 resolveProviderModel → 配置 llm providers/models。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 注册两个子代理，各自携带 assistant 输出（startContinuable 按 index 返回 child-1/child-2）。
    const child1 = new FakeAgent('child-1');
    child1.session.append(assistantMessageEvent([{ type: 'text', text: 'output A' }]));
    const child2 = new FakeAgent('child-2');
    child2.session.append(assistantMessageEvent([{ type: 'text', text: 'output B' }]));
    agents.register(child1);
    agents.register(child2);

    // step-end 的 shell handler（默认 FakeShell 无 handler → 抛错；需设置）。
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'end', stderr: '' });

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // router + step-a + step-b + step-end = 4 段（两个 agent step 并发执行）。
    expect(result.executedSteps).toHaveLength(4);
    // 两个 agent step 均完成（各自 whenIdle 被 Promise.all 聚合）。
    const agentSteps = result.executedSteps.filter(s => s.stepId === 'step-a' || s.stepId === 'step-b');
    expect(agentSteps).toHaveLength(2);
    expect(agentSteps.every(s => s.status === 'completed')).toBe(true);
    // startContinuable 被调用 2 次（两个 agent step 各启动一个子代理）。
    expect(subagents.continuableStarts).toHaveLength(2);
  });
});

describe('StageExecutor 5 阶段收尾（4.6/4.7：Phase A ask 保底 → Phase B/C → resume 状态流转）', () => {
  it('Phase A ask 保底置 interacting（finalizeMeta currentPhase=ask-detect），resume 后 Phase B/C 完成', async () => {
    const { llm, agents, makeExecutor } = harness();
    let call = 0;
    llm.streamHandler = () => {
      // 首次评估判定需提问；回答后续跑重评估判定完成。
      const askJson = '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"确认继续？","options":[{"label":"A"}]}]}}';
      return textChunks(call++ === 0 ? askJson : '{"hasAsk":false,"passThroughVars":{}}');
    };
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Round 20：shell 步骤跳过 Phase A（无 ask 通道）——本用例改用 prompt Step 验证
    // ask 保底链路（prompt Step 声明未解析透传变量 → needsAssess（Phase A 跑评估））。
    const step: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'prompt', value: { promptText: 'do work' } },
      passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'Stage 1', steps: [{ id: 'step-sh' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-1', name: 'wfl-1', version: '1', stages: [stage], steps: [step], settings: {},
    };
    // prompt Step 走可续接子代理：注册真实 childId 并回填最终输出（resume 续跑复用）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });

    // 首次 execute：Phase A ask 保底 → 实例 interacting（引擎 ask 闭环）；Step 段
    // 保持 running（偏离 8：interacting 只设 state.status）。
    const first = await executor.execute();
    expect(first.status).toBe('interacting');
    expect(first.executedSteps[0]?.status).toBe('running');
    // Phase A 中断快照：currentPhase='ask-detect'，顶层 assessSessionId 不记录
    // （临时会话用完即删不持久化；Phase B 收尾才落 assessSessionId）。
    expect(first.executedSteps[0]?.finalizeMeta?.currentPhase).toBe('ask-detect');
    expect(first.executedSteps[0]?.finalizeMeta?.assessSessionId).toBeUndefined();
    expect(first.executedSteps[0]?.finalizeMeta?.askResult?.hasAsk).toBe(true);

    // 回答后再次 execute：resumePendingAsk（prompt 真实子代理重收集输出）→ Phase B 真 fork
    // 子代理重新评估（finalizeMeta currentPhase='finalizing'）→ Phase C（无门禁 ok）→ 完成。
    const second = await executor.execute();
    expect(second.status).toBe('completed');
    expect(second.executedSteps[0]?.status).toBe('completed');
    expect(second.executedSteps[0]?.finalizeMeta?.currentPhase).toBe('completed');
    // Phase B 起持久化 assessSessionId（评估 fork id；无 fork 配置降级 eval- 句柄）。
    // Round 17：顶层 assessSessionId 已删除，sessionId 从 assessResult.forkSessionId 内读
    expect(second.executedSteps[0]?.finalizeMeta?.assessResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('shell Step 跳过 Phase A/B 收尾评估（Round 20：直接 Phase C 门禁 → completed）', async () => {
    // shell 步骤声明未解析透传变量 + 门禁——修复前会触发 Phase A assess（ask 通道）+
    // Phase B assess（compressedOutput）；Round 20 后 shell 跳过两者，仅 Phase C
    // primary 纯代码门禁（零 AI）运行。
    const { definition, stage } = singleShellDefinition();
    const shellStep: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'shell', value: { command: 'echo hi' } },
      passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      gates: { primary: { enabled: true } },
    };
    const def: WorkflowDefinition = { ...definition, steps: [shellStep] };
    const { llm, shell, makeExecutor } = harness();
    llm.streamHandler = () => textChunks('should not be called');
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor({ stageDef: stage, workflowDef: def });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    const segment = result.executedSteps[0]!;
    // shell 跳过 Phase A/B：零 llm 调用、无 assessResult（Phase B 不跑、无压缩输出）。
    expect(llm.calls).toHaveLength(0);
    expect(segment.finalizeMeta?.assessResult).toBeUndefined();
    // Phase C primary 门禁仍运行（纯代码产物校验；无 outputTo → 直接通过）。
    expect(segment.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    // 命令输出直接展示（completed 段保留原始 output 供 UI shell 分支显示）。
    expect(segment.output).toHaveLength(1);
    expect(segment.output[0]?.type).toBe('text');
  });
});

// ── 收尾真 fork（Phase A 临时会话 / Phase B agents.create 重建宿主子代理） ─────────

describe('StageExecutor 收尾真 fork（5 阶段收尾重构）', () => {
  /** 组装单 agent Step（未解析透传变量 → Phase A + Phase B 均跑评估）。 */
  function agentFinalizeDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage; step: WorkflowStep } {
    const step: WorkflowStep = {
      id: 'step-a',
      name: 'agent',
      command: { type: 'agent', value: { promptText: 'do work' } },
      passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'Stage 1', steps: [{ id: 'step-a' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-agent-finalize', name: 'wfl-agent-finalize', version: '1', stages: [stage], steps: [step], settings: {},
    };
    return { definition, stage, step };
  }

  /** 源子代理完整事件（turn 0 闭合：start/user/assistant/end）。 */
  function childEvents(): Array<{ type: string; seq: number; time: number; data: unknown }> {
    return [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
      { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', content: [{ type: 'text', text: 'do work' }] } },
      { type: 'assistant/message', seq: 2, time: 0, data: { turn: 0, step: 0, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'agent work output' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'completed' } } },
    ];
  }

  it('Phase B 真 fork：agents.create 收到 seed=完整事件 + meta.parentSession=宿主主代理 + origin=subagent；透传变量在 Phase B 回写；compressedOutput 落 previousOutputs；Phase D routing 落盘', async () => {
    // 两步工作流：step-a（agent + 未解析透传变量，Phase B 真 fork）→ step-b（prompt，
    // 引用前置输出——验证 compressedOutput 经 previousOutputs 进入 step-b 提示词）。
    const stepA: WorkflowStep = {
      id: 'step-a',
      name: 'agent',
      command: { type: 'agent', value: { promptText: 'do work' } },
      passThroughVars: [{ name: 'projectName', value: '${projectName}', description: 'project' }],
    };
    const stepB: WorkflowStep = {
      id: 'step-b',
      name: 'consume',
      command: { type: 'prompt', value: { promptText: 'review previous' } },
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'Stage 1', steps: [{ id: 'step-a' }, { id: 'step-b' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-fork-b2', name: 'wfl-fork-b2', version: '1', stages: [stage], steps: [stepA, stepB], settings: {},
    };
    const { llm, subagents, agents, makeExecutor } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Phase A 评估临时会话（llm.stream：completed JSON；Phase A 不写回透传变量）。
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');
    // agent Step（step-a）的执行子代理（child-1，输出 'agent work output'）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent work output' }]));
    agents.register(child);
    // step-b 的执行子代理（child-2）。
    const childB = new FakeAgent('child-2');
    childB.session.append(assistantMessageEvent([{ type: 'text', text: 'review done' }]));
    agents.register(childB);
    // Phase B 真 fork 的评估回复（一个 LLM 调用返回合并 JSON：passThroughVars + compressedOutput）。
    agents.createFollowupHandler = () => [{ type: 'text', text: '{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"agent 压缩摘要"}' }];
    // 记录收尾阶段流转（Phase B finalizing → Phase D routing → completed）。
    const phases: Array<{ stepId: string; phase: string }> = [];

    const executor = makeExecutor(
      {
        stageDef: stage,
        workflowDef: definition,
        hooks: {
          onStepStart: () => {},
          onStepCompleted: () => {},
          onStepFailed: () => {},
          onPhaseChange: (step, _childId, phase) => phases.push({ stepId: step.id, phase }),
        },
      },
      {
        defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm',
        hostAgentId: 'host-1',
        // 引擎真实链路注入 hostAgent（Agent 对象）→ fork-session 经 childSessionMeta
        // 产出 delegationDepth/agentPreset 的 meta + setup（policy/composition）。
        hostAgent: new FakeAgent('host-1'),
        createAgent: options => agents.create(options),
        getStepSessionEvents: async childId => (childId === 'child-1' ? childEvents() : undefined),
      },
    );
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // Phase B 真 fork：agents.create 收到 seed = 完整事件 + meta（parentSession=宿主主代理、
    // origin='subagent'、isSeeded=true、delegationDepth=1、cwd=/tmp；上游适配：seedLength
    // 已删，前缀长度移到顶层 inheritedEventCount=4）。
    expect(agents.createSeeds).toHaveLength(1);
    expect(agents.createSeeds[0]).toEqual(childEvents());
    expect(agents.createMetas[0]).toEqual({ cwd: '/tmp', parentSession: 'host-1', isSeeded: true, origin: 'subagent', delegationDepth: 1 });
    expect(agents.createInheritedEventCounts[0]).toBe(4);
    // 合成 fork 会话 id：纯 UUID（globalThis.crypto.randomUUID()）。
    const segment = result.executedSteps.find(s => s.stepId === 'step-a')!;
    // Round 17：顶层 assessSessionId 已删除，sessionId 从 assessResult.forkSessionId 内读
    expect(segment.finalizeMeta?.assessResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // 驱动一轮：followup 收到收尾处理提示词（含 compressedOutput 格式）、whenIdle 被 await。
    const forkedAgent = agents.createdAgents[0]!;
    expect(forkedAgent.followups).toHaveLength(1);
    expect(forkedAgent.whenIdleCount).toBe(1);
    // Phase B 真 fork 子代理不消费 llm.stream → 仅 Phase A 临时会话 1 次调用。
    expect(llm.calls).toHaveLength(1);
    // 评估完 dispose：live 移除。
    expect(agents.get(segment.finalizeMeta!.assessResult!.forkSessionId)).toBeUndefined();
    // 透传变量回写（保留 description）——阶段契约与累加器均落账。
    expect(result.passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
    expect(result.stageContract.passThroughVars['projectName']).toEqual({ value: 'sandore', description: 'project' });
    // Phase B JSON 的 compressedOutput 经 previousOutputs 落入 step-b 的提示词
    // （「前置Step: ... 的输出和产物」Reference 块的 Output，替代原 compressStepOutput）。
    // step-a（agent）为第 1 个 startContinuable（child-1），step-b（prompt）为第 2 个。
    const stepBPrompt = textOf(subagents.continuableStarts[1]?.request.prompt[0]);
    expect(stepBPrompt).toContain('的输出和产物');
    expect(stepBPrompt).toContain('agent 压缩摘要');
    // 收尾阶段流转：step-a finalizing（进入 Phase B 先 commit 快照）→ finalizing（Phase B 完成后 commit）
    // → routing（Phase D）→ completed；step-b 无变量无门禁跳过收尾。
    expect(phases).toEqual([
      { stepId: 'step-a', phase: 'finalizing' },
      { stepId: 'step-a', phase: 'finalizing' },
      { stepId: 'step-a', phase: 'routing' },
      { stepId: 'step-a', phase: 'completed' },
    ]);
  });

  it('Phase B 事件源缺失（shell 合成会话）→ 降级临时会话并记 errorDetail（不失败）', async () => {
    const { definition, stage } = agentFinalizeDefinition();
    const { llm, agents, makeExecutor } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Phase A + Phase B 降级均走 llm.stream（两段 completed JSON）。
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent work output' }]));
    agents.register(child);

    const executor = makeExecutor(
      { stageDef: stage, workflowDef: definition },
      {
        defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm',
        hostAgentId: 'host-1',
        createAgent: options => agents.create(options),
        // 无事件源（child-1 未登记/合成会话）→ assessForked 降级临时会话。
        getStepSessionEvents: async () => undefined,
      },
    );
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // 无 agents.create（forkStepSubagent 在取事件处即降级）。
    expect(agents.createSeeds).toHaveLength(0);
    const segment = result.executedSteps[0]!;
    // 降级后 forkSessionId 为纯 UUID 句柄，assessResult.errorDetail 记降级原因。
    // Round 17：顶层 assessSessionId 已删除，sessionId 从 assessResult.forkSessionId 内读
    expect(segment.finalizeMeta?.assessResult?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(segment.finalizeMeta?.assessResult?.errorDetail).toContain('no event source');
    // Phase A + Phase B 降级 = 2 次 llm.stream。
    expect(llm.calls).toHaveLength(2);
  });
});

// ── bugfix round22：runLoop pendingQueue+Promise.race 重构（新并发模型专项） ────────

/** settle 控制器（对齐 step-runner.spec）：注入 awaitSubagentSettlement + 测试手动 settle。 */
function settleController(): {
  awaitSubagentSettlement: (childId: string, signal: AbortSignal) => Promise<SubagentSettlement>;
  settle: (childId: string, stopReason: SubagentStopReason, output?: readonly ContentBlock[]) => void;
} {
  const pending = new Map<string, (settlement: SubagentSettlement) => void>();
  const buffered = new Map<string, SubagentSettlement>();
  return {
    awaitSubagentSettlement: async childId => {
      const existing = buffered.get(childId);
      if (existing !== undefined) {
        buffered.delete(childId);
        return existing;
      }
      return await new Promise<SubagentSettlement>(resolve => {
        pending.set(childId, resolve);
      });
    },
    settle: (childId, stopReason, output) => {
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
    },
  };
}

/** 组装失败/成功 shell 结果（减少重复样板）。 */
function shellResult(spec: { timeoutMs?: number }, stdout: string, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stdout: { text: stdout, truncated: false },
    stderr: { text: exitCode === 0 ? '' : 'boom', truncated: false },
  };
}

describe('StageExecutor bugfix round22：runLoop pendingQueue+Promise.race 新模型', () => {
  // 新增单测 ①：并发完成/失败 status 竞态——条件 completed 写被终态拦截，最终 failed。
  it('concurrent completed + failed branches settle to failed (conditional completed write)', async () => {
    const { definition, stage } = parallelBranchDefinition();
    const { shell, makeExecutor } = harness();
    // step-a（echo a）成功但延迟完成（gate 放行）；step-b（echo b）立即失败。
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    shell.runHandler = async spec => {
      if (spec.command === 'echo b') {
        return shellResult(spec, '', 1);
      }
      if (spec.command === 'echo a') {
        await gate; // 先让 step-b 失败落终态，再放行 step-a（条件 completed 写被 failed 拦截）
      }
      return shellResult(spec, 'done');
    };
    const commits: Array<{ status?: string; errorDetail?: string }> = [];
    const executor = makeExecutor({
      stageDef: stage,
      workflowDef: definition,
      commitState: patch => commits.push(patch),
    });
    const resultP = executor.execute();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    release();
    const result = await resultP;

    expect(result.status).toBe('failed');
    // step-a 段仍 completed（P3 persist 无条件、段快照完整）；step-b 段 failed。
    expect(result.executedSteps.find(s => s.stepId === 'step-a')?.status).toBe('completed');
    expect(result.executedSteps.find(s => s.stepId === 'step-b')?.status).toBe('failed');
    // 终态后不再有 completed commit（条件写被拦）；最后一次 status commit 为 failed。
    const lastStatusCommit = [...commits].reverse().find(p => p.status !== undefined);
    expect(lastStatusCommit?.status).toBe('failed');
    // 终止态跳过剩余节点：step-end 不执行。
    expect(result.executedSteps.some(s => s.stepId === 'step-end')).toBe(false);
  });

  // 新增单测 ②：循环门 quiescent barrier——并行循环体汇聚回循环门不提前路由（G10）。
  it('loop gate routes only when quiescent (parallel body branches converge, iteration count correct)', async () => {
    const stepLoop: WorkflowStep = { id: 'step-loop', name: 'Loop' };
    const stepBodyRouter: WorkflowStep = { id: 'step-body-router', name: 'BodyRouter' };
    const stepB1: WorkflowStep = { id: 'step-b1', name: 'B1', command: { type: 'shell', value: { command: 'echo b1' } } };
    const stepB2: WorkflowStep = { id: 'step-b2', name: 'B2', command: { type: 'shell', value: { command: 'echo b2' } } };
    const stepEnd: WorkflowStep = { id: 'step-end', name: 'End', command: { type: 'shell', value: { command: 'echo end' } } };
    const stage: WorkflowStage = {
      id: 'stg-1', name: 'LoopBarrier',
      steps: [
        { id: 'step-loop', branches: [{ loop: { next: 'step-body-router', exitTo: 'step-end', maxIterations: 3 } }] },
        { id: 'step-body-router', branches: [{ next: 'step-b1' }, { next: 'step-b2' }] },
        { id: 'step-b1', branches: [{ next: 'step-loop' }] },
        { id: 'step-b2', branches: [{ next: 'step-loop' }] },
        { id: 'step-end' },
      ],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-loop-barrier', name: 'wfl-loop-barrier', version: '1', settings: {}, stages: [stage],
      steps: [stepLoop, stepBodyRouter, stepB1, stepB2, stepEnd],
    };
    const { shell, makeExecutor } = harness();
    // b2 延迟完成：b1 完成后循环门入队，barrier 必须等同迭代 b2 落地才路由；若提前路由
    // （无 barrier）→ 迭代语义破坏（visitCount 超前 → 提前 break → 循环发散/计数错误）。
    shell.runHandler = async spec => {
      if (spec.command === 'echo b2') {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      return shellResult(spec, spec.command);
    };

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // maxIterations=3 → 2 轮迭代 × 2 并行分支 = body 恰好执行 4 次（barrier 保证不提前 break）。
    const bodySegs = result.executedSteps.filter(s => s.stepId === 'step-b1' || s.stepId === 'step-b2');
    expect(bodySegs).toHaveLength(4);
    expect(bodySegs.every(s => s.status === 'completed')).toBe(true);
    // 循环跳出 exitTo 推进 step-end 恰好一次。
    const endSegs = result.executedSteps.filter(s => s.stepId === 'step-end');
    expect(endSegs).toHaveLength(1);
    expect(endSegs[0]?.status).toBe('completed');
  });

  // 新增单测 ③：persist 顺序——完成节点 P3 持久化快照已含其 nexts（enqueue 先于 P3）。
  it('completed step persist snapshot already contains its nexts (enqueue before P3)', async () => {
    const { definition, stage } = singleShellDefinition();
    const stepA: WorkflowStep = { id: 'step-a', name: 'a', command: { type: 'shell', value: { command: 'echo a' } } };
    const stepB: WorkflowStep = { id: 'step-b', name: 'b', command: { type: 'shell', value: { command: 'echo b' } } };
    const twoStepStage: WorkflowStage = { ...stage, steps: [{ id: 'step-a' }, { id: 'step-b' }] };
    const twoStepDef: WorkflowDefinition = { ...definition, stages: [twoStepStage], steps: [stepA, stepB] };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => shellResult(spec, spec.command);
    const persists: Array<{ stepId: string | undefined; status: string; pendingQueue: readonly string[] | undefined }> = [];
    const executor = makeExecutor({
      stageDef: twoStepStage,
      workflowDef: twoStepDef,
      onPersist: async (executed, pendingQueue) => {
        persists.push({ stepId: executed.stepId, status: executed.status, pendingQueue });
      },
    });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // step-a 的 P3 completed 快照必须已含 next（step-b）——enqueue 先于 persist（崩溃窗口闭合）。
    const aCompleted = persists.find(p => p.stepId === 'step-a' && p.status === 'completed');
    expect(aCompleted?.pendingQueue).toContain('step-b');
    // step-a 的 P1 running 快照在路由前：不含 step-b。
    const aRunning = persists.find(p => p.stepId === 'step-a' && p.status === 'running');
    expect(aRunning?.pendingQueue).not.toContain('step-b');
  });

  // 新增单测 ④：resume 混合播种——resumeSubagents 走 resumeSegments 分流、快照节点正常拉起、去重生效。
  it('resume mixed seeding: segments go through resumeSegments, snapshot nodes pull up, dedupe works', async () => {
    const stepRouter: WorkflowStep = { id: 'step-router', name: 'Router' };
    const stepB: WorkflowStep = { id: 'step-b', name: 'B', command: { type: 'agent', value: { promptText: 'do B' } } };
    const stepC: WorkflowStep = { id: 'step-c', name: 'C', command: { type: 'shell', value: { command: 'echo c' } } };
    const stepEnd: WorkflowStep = { id: 'step-end', name: 'End', command: { type: 'shell', value: { command: 'echo end' } } };
    const stage: WorkflowStage = {
      id: 'stg-1', name: 'MixedResume',
      steps: [
        { id: 'step-router', branches: [{ next: 'step-b' }, { next: 'step-c' }] },
        { id: 'step-b', branches: [{ next: 'step-end' }] },
        { id: 'step-c', branches: [{ next: 'step-end' }] },
        { id: 'step-end' },
      ],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-mixed-resume', name: 'wfl-mixed-resume', version: '1', settings: {}, stages: [stage],
      steps: [stepRouter, stepB, stepC, stepEnd],
    };
    const routerSeg: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-router', stepId: 'step-router', stageId: 'stg-1', name: 'Router', status: 'completed',
      visitCount: 1, createdAt: '2026-08-16T00:00:00.000Z', attemptIndex: 0,
    };
    const runningB: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-b', stepId: 'step-b', stageId: 'stg-1', name: 'B', status: 'running',
      command: { type: 'agent', value: { promptText: 'do B' } },
      sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
      visitCount: 1, createdAt: '2026-08-16T00:00:00.000Z', attemptIndex: 0,
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [routerSeg],
      resumeSubagents: [{ step: stepB, executed: runningB, childId: 'child-1' }],
      // 快照 pendingQueue：step-c 正常拉起；step-b 命中 resumeSegments → initState 去重跳过。
      pendingQueue: ['step-c', 'step-b'],
    };
    const { shell, agents, makeExecutor } = harness();
    // resume 段续跑：子代理 child-1 已有输出（whenIdle + finalAssistantOutput 回退路径）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed B' }]));
    agents.register(child);
    // step-end 延迟完成：确保两个分支先后路由到同一后继时 running 去重生效（不二次执行）。
    shell.runHandler = async spec => {
      if (spec.command === 'echo end') {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      return shellResult(spec, 'done');
    };

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, resumeFrom });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // resume 段走 resumeSegments 分流：沿用原段 id（exec-b），不新建执行段（非重新执行）。
    const bSegs = result.executedSteps.filter(s => s.stepId === 'step-b');
    expect(bSegs).toHaveLength(1);
    expect(bSegs[0]?.id).toBe('exec-b');
    expect(bSegs[0]?.status).toBe('completed');
    // 快照节点 step-c 正常拉起执行（新段）。
    const cSegs = result.executedSteps.filter(s => s.stepId === 'step-c');
    expect(cSegs).toHaveLength(1);
    expect(cSegs[0]?.status).toBe('completed');
    // 汇聚 step-end 恰好一次（两分支先后路由到同一后继 → enqueue/running 去重生效）。
    const endSegs = result.executedSteps.filter(s => s.stepId === 'step-end');
    expect(endSegs).toHaveLength(1);
  });

  // 新增单测 ⑤：终态优先级——并发 failed + paused → 最终 failed（runLoop 末尾 re-assert，G11）。
  it('concurrent failed + paused settle to failed (terminal priority re-assert)', async () => {
    const stepRouter: WorkflowStep = { id: 'step-router', name: 'Router' };
    const stepA: WorkflowStep = { id: 'step-a', name: 'A', command: { type: 'agent', value: { promptText: 'do A' } } };
    const stepB: WorkflowStep = { id: 'step-b', name: 'B', command: { type: 'shell', value: { command: 'echo fail' } } };
    const stepEnd: WorkflowStep = { id: 'step-end', name: 'End', command: { type: 'shell', value: { command: 'echo end' } } };
    const stage: WorkflowStage = {
      id: 'stg-1', name: 'Priority',
      steps: [
        { id: 'step-router', branches: [{ next: 'step-a' }, { next: 'step-b' }] },
        { id: 'step-a', branches: [{ next: 'step-end' }] },
        { id: 'step-b', branches: [{ next: 'step-end' }] },
        { id: 'step-end' },
      ],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-priority', name: 'wfl-priority', version: '1', settings: {}, stages: [stage],
      steps: [stepRouter, stepA, stepB, stepEnd],
    };
    const ctrl = settleController();
    const { llm, shell, agents, makeExecutor } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'A output' }]));
    agents.register(child);
    // step-b 立即失败；step-a（agent）等 settle（aborted → 暂停）。
    shell.runHandler = async spec => shellResult(spec, '', 1);
    const commits: Array<{ status?: string }> = [];
    const executor = makeExecutor({
      stageDef: stage,
      workflowDef: definition,
      runnerConfig: { defaultTimeoutMs: 60000, awaitSubagentSettlement: ctrl.awaitSubagentSettlement },
      commitState: patch => commits.push(patch),
    });
    const resultP = executor.execute();
    // 等 step-b 失败先落终态（failed），再让 step-a 暂停（paused 的 last-write-wins 覆盖
    // failed —— 由 runLoop 末尾 terminalPriority re-assert 纠正回 failed，G11）。
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    ctrl.settle('child-1', 'aborted');
    const result = await resultP;

    expect(result.status).toBe('failed');
    // step-a 段 paused（暂停落段）、step-b 段 failed。
    expect(result.executedSteps.find(s => s.stepId === 'step-a')?.status).toBe('paused');
    expect(result.executedSteps.find(s => s.stepId === 'step-b')?.status).toBe('failed');
    // 终止态跳过剩余节点：step-end 不执行。
    expect(result.executedSteps.some(s => s.stepId === 'step-end')).toBe(false);
    // re-assert 兜底：最后一次 status commit 为 failed（paused 覆盖 failed 被纠正）。
    const lastStatusCommit = [...commits].reverse().find(p => p.status !== undefined);
    expect(lastStatusCommit?.status).toBe('failed');
  });

  // 新增单测 ⑥：resume 空队列——resumeFrom 仅 completedSteps（反推空 next）→ completed（循环末兜底）。
  it('resumeFrom with only completedSteps and empty reverse-derived nexts → status completed', async () => {
    const { definition, stage } = singleShellDefinition();
    const completed: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-sh', stepId: 'step-sh', stageId: 'stg-1', name: 'echo', status: 'completed',
      command: { type: 'shell', value: { command: 'echo hi' } },
      sessionMeta: { childId: 'step-sh-synthetic', synthetic: true, command: 'shell' },
      visitCount: 1, createdAt: '2026-08-16T00:00:00.000Z', attemptIndex: 0,
      output: [{ type: 'text', text: 'hi' }],
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [completed],
      resumeBetweenSteps: true,
    };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => shellResult(spec, 'hi');

    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, resumeFrom });
    const result = await executor.execute();

    // 反推空 next → pendingQueue 空 → 循环末兜底 completed（不重跑已完成 Step）。
    expect(result.status).toBe('completed');
    expect(result.executedSteps).toHaveLength(1);
    expect(result.executedSteps[0]?.id).toBe('exec-sh');
  });

  // 新增单测 ⑦：limiter 等待窗口终态跳过——acquire 期间另一节点失败 → acquire 后返回 skipped 不执行。
  it('limiter waiting window: terminal state before acquire → startNode returns skipped without executing', async () => {
    const { definition, stage } = parallelBranchDefinition();
    const { shell, makeExecutor } = harness();
    // step-a（echo a）持有槽位并失败；step-b（echo b）排队等待 acquire。
    const startedCommands: string[] = [];
    shell.runHandler = async spec => {
      startedCommands.push(spec.command);
      return spec.command === 'echo a' ? shellResult(spec, '', 1) : shellResult(spec, 'done');
    };
    const limiter = new TrackingLimiter(1);
    const executor = makeExecutor({ stageDef: stage, workflowDef: definition, concurrencyLimiter: limiter });
    const result = await executor.execute();

    expect(result.status).toBe('failed');
    // step-a 段 failed 落盘；step-b 未执行（acquire 后终态检查返回 skipped：不产段、不跑 shell）。
    expect(result.executedSteps.find(s => s.stepId === 'step-a')?.status).toBe('failed');
    expect(result.executedSteps.some(s => s.stepId === 'step-b')).toBe(false);
    expect(startedCommands).not.toContain('echo b');
  });
});

// ── 端到端复现：崩溃恢复后 loop maxIterations 计数不虚高（resume 节点出队不重复 +1） ──
//
// 2026-08-25 实测根因：实例（1cf77eea）内层循环配置 maxIterations=3 只跑了 2 次——
// resumeInfo 把崩溃活跃段放入 resumeSubagents，initState 又将其重新入队（initialQueue），
// 恢复后 runLoop 出队时 visitCount 再次 +1（虚高，如 sce1 执行 1 段却计数 2）→
// checkLoopBreak 的 `visitCount >= maxIterations` 提前命中 → 循环体少跑一次。
// 修复：resumeSegments 命中的节点出队不 +1（续跑同一执行段，非新访问）。
describe('StageExecutor e2e：崩溃恢复 loop 计数（resume 节点不重复计 visitCount）', () => {
  it('resume 续跑后 maxIterations=3 循环体仍执行满 3 次', async () => {
    const sce2: WorkflowStep = { id: 'sce2', name: 'sce2', command: { type: 'shell', value: { command: 'echo sce2' } } };
    const fix: WorkflowStep = {
      id: 'fix', name: 'fix',
      command: { type: 'agent', value: { promptText: 'fix counts' } },
      branches: [{
        next: 'sce2',
        loop: { next: 'sce2', maxIterations: 3, exitTo: 'done' },
      }],
    };
    const done: WorkflowStep = { id: 'done', name: 'done', command: { type: 'shell', value: { command: 'echo done' } } };
    const stage: WorkflowStage = {
      id: 'stg-1', name: 'demo1',
      steps: [{ id: 'sce2' }, { id: 'fix', branches: [{ next: 'sce2', loop: { next: 'sce2', maxIterations: 3, exitTo: 'done' } }] }, { id: 'done' }],
    };
    const definition: WorkflowDefinition = {
      id: 'wfl-loop-resume', name: 'wfl-loop-resume', version: '1', stages: [stage],
      steps: [sce2, fix, done], settings: {},
    };
    const { agents, llm, shell, makeExecutor } = harness();
    shell.runHandler = async spec => shellResult(spec, 'done');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // fix 的子代理（resume 续跑与正常执行共用；同一 child 复用）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'fix done' }]));
    agents.register(child);
    // 第 3 次 fix 正常执行的 startContinuable 会生成 child-2（FakeSubagents 递增 index）。
    const child2 = new FakeAgent('child-2');
    child2.session.append(assistantMessageEvent([{ type: 'text', text: 'fix done 2' }]));
    agents.register(child2);

    // 崩溃快照（循环体顺序 sce2 → fix）：sce2(0)、sce2(1)、fix(0) 已 completed；
    // fix(1) 正在跑（活跃段，第 2 次循环的 fix）；pendingQueue=[fix]。
    const completedSteps = [
      { id: 'exec-1', stepId: 'sce2', stageId: 'stg-1', name: 'sce2', status: 'completed', visitCount: 1 },
      { id: 'exec-1b', stepId: 'sce2', stageId: 'stg-1', name: 'sce2', status: 'completed', visitCount: 2 },
      { id: 'exec-2', stepId: 'fix', stageId: 'stg-1', name: 'fix', status: 'completed', visitCount: 1 },
    ];
    const resumeFrom: StageExecutorResume = {
      completedSteps,
      resumeSubagents: [{
        step: fix,
        executed: { id: 'exec-3', stepId: 'fix', stageId: 'stg-1', name: 'fix', status: 'running', visitCount: 2, sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' } },
        childId: 'child-1',
      }],
      pendingQueue: ['fix'],
    };

    const visitCounts = { sce2: 2, fix: 2 }; // 崩溃前出队计数：sce2(0,1)、fix(0,1)
    const executor = makeExecutor({
      stageDef: stage,
      workflowDef: definition,
      resumeFrom,
      visitCounts,
    });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // 循环体执行满 3 次（maxIterations=3）：sce2 段 3 个（exec-1/exec-1b + 1 个新）、
    // fix 段 3 个（exec-2 + exec-3 续跑 + 1 个新）。
    const sce2Segs = result.executedSteps.filter(s => s.stepId === 'sce2');
    const fixSegs = result.executedSteps.filter(s => s.stepId === 'fix');
    expect(sce2Segs).toHaveLength(3);
    expect(fixSegs).toHaveLength(3);
    expect(fixSegs.map(s => s.status)).toEqual(['completed', 'completed', 'completed']);
    // done 恰好一次（exitTo）。
    expect(result.executedSteps.filter(s => s.stepId === 'done')).toHaveLength(1);
  });
});
//
// 2026-08-25 实测根因：outputTo 路径引用本 step 提取的透传变量（`artifacts/${change-name}/...`）
// 时，「buildFinalizeContext 早期收集」用 pre-finalize vars（变量未写回）→ 收集空 → 段快照
// artifacts 不写 → 导航无产物；而门禁用「累加器 + 当次提取」合并 vars → 能解析 → 门禁通过
// （「门禁过但导航无产物」）。修复：buildPhaseBPreviousOutput（Phase B 后、变量已写回）的
// 收集结果写回 executed.artifacts，保证最终产物与门禁一致。
describe('StageExecutor e2e：自引用透传变量产物（导航产物缺失根因复现）', () => {
  it('Phase B 写回后收集产物 → executed.artifacts 与 stage 契约一致', async () => {
    const stepA: WorkflowStep = {
      id: 'step-a', name: 'sce1',
      command: { type: 'agent', value: { promptText: 'generate proposal' } },
      passThroughVars: [{ name: 'change-name', value: '', description: '当前变更名称' }],
      outputTo: [{ id: 'opt-1', path: 'artifacts/${change-name}/proposal.md' }],
      // 门禁启用 → runPhaseA/B 的跳过谓词（无未解析变量且无门禁）不命中 → 评估提取执行
      // （与真实工作流一致：有门禁的 step 才会跑收尾评估提取透传变量）。
      gates: { primary: { enabled: true } },
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'demo1', steps: [{ id: 'step-a' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-self-var', name: 'wfl-self-var', version: '1', stages: [stage], steps: [stepA], settings: {},
    };
    const { llm, agents, fs, makeExecutor } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Phase A 临时会话：提取为空（ask 判定 false）。
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'proposal generated' }]));
    agents.register(child);
    // Phase B 真 fork 评估回复：提取 change-name=book-management（LLM 从输出提取）。
    agents.createFollowupHandler = () => [{ type: 'text', text: '{"passThroughVars":{"change-name":"book-management"},"compressedOutput":"proposal 摘要"}' }];
    // 产物文件已由子代理生成（outputTo 命中路径）。
    fs.seedFile('/tmp/artifacts/book-management/proposal.md');
    // 源子代理完整事件（turn 0 闭合：start/user/assistant/end，供 forkStepSubagent 重建）。
    const childEvents = (): Array<{ type: string; seq: number; time: number; data: unknown }> => [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
      { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', content: [{ type: 'text', text: 'do work' }] } },
      { type: 'assistant/message', seq: 2, time: 0, data: { turn: 0, step: 0, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'proposal generated' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 0, reason: { kind: 'completed' } } },
    ];

    const executor = makeExecutor(
      {
        stageDef: stage,
        workflowDef: definition,
        hooks: { onStepStart: () => {}, onStepCompleted: () => {}, onStepFailed: () => {} },
      },
      {
        defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm',
        hostAgentId: 'host-1',
        createAgent: options => agents.create(options),
        getStepSessionEvents: async childId => (childId === 'child-1' ? childEvents() : undefined),
      },
    );
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // ① 写回：引擎累加器含提取值（Phase B commitFinalize('finalizing')）。
    expect(result.passThroughVars['change-name']).toEqual({ value: 'book-management', description: '当前变更名称' });
    // ② 段快照产物：自引用变量解析后收集成功（修复前为 undefined）。
    const segment = result.executedSteps.find(s => s.stepId === 'step-a')!;
    expect(segment.artifacts).toEqual(['/tmp/artifacts/book-management/proposal.md']);
    // ③ stage 契约产物一致（stage 级权威汇总）。
    expect(result.stageContract.artifacts[0]?.files).toEqual(['/tmp/artifacts/book-management/proposal.md']);
  });
});
