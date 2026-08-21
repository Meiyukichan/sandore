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
 * @module @deepseek-ai/dsh-sandore-microflow/src/stage-executor.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../../workflow/tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import type { ConcurrencyLimiter } from './concurrency-limiter.ts';
import { FinalizeManager } from './finalize-manager.ts';
import type { FinalizeManagerConfig } from './finalize-manager.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome } from './file-utils.ts';
import type { LoopState } from './loop-manager.ts';
import { StageExecutor } from './stage-executor.ts';
import type { StageExecutorOptions, StageExecutorResume } from './stage-executor.ts';
import { StepNavigator } from './step-navigator.ts';
import type { StepRunnerConfig } from './step-runner.ts';

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
  makeExecutor: (options?: Partial<StageExecutorOptions>) => StageExecutor;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subagents = new FakeSubagents();
  const subprocess = new FakeSubprocess();
  const fs = new FakeFs();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subagents', subagents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('sessions', {} as unknown as SessionStore);
  ctx.provide('fs', fs as unknown as FileSystem);

  const makeExecutor = (options?: Partial<StageExecutorOptions>): StageExecutor => {
    const { definition, stage } = singleShellDefinition();
    const stageDef = options?.stageDef ?? stage;
    const workflowDef = options?.workflowDef ?? definition;
    const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
    // Step 级路由已归 microflow：用真实 StepNavigator（持当前 Stage Step 节点图 + 循环管理器），
    // 不再经 options 注入 resolveNextNodes。
    const stepNavigator = new StepNavigator(ctx, { defaultTimeoutMs: 60000 }, loopState, stageDef, workflowDef);
    const loopManager = stepNavigator.loopManagerInstance;
    const config: FinalizeManagerConfig = { defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' };
    const finalizeManager = new FinalizeManager(ctx, config);
    const runnerConfig: StepRunnerConfig = { defaultTimeoutMs: 60000 };
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
      ...(options?.concurrencyLimiter === undefined ? {} : { concurrencyLimiter: options.concurrencyLimiter }),
      visitCounts: {},
      ...(options?.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
      onPersist: async () => {},
    });
  };

  return { ctx, llm, shell, subagents, subprocess, fs, makeExecutor };
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
    expect(segment.sessionMeta?.childId).toMatch(/^step-step-sh-[0-9a-f]{8}$/);
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
    const { ctx, makeExecutor } = harness();
    // 注册续跑的子代理（whenIdle 后取 final output）。
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    agents.register(child);
    ctx.provide('agents', agents);

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
    const { ctx, llm, subagents, makeExecutor } = harness();
    // prompt Step 走可续接子代理（决策 D3）：provider/model 走 llm 目录（L3）兜底，
    // 注册真实 childId 并回填最终输出。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'report content' }]));
    agents.register(child);
    ctx.provide('agents', agents);

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
    const { ctx, llm, subagents, makeExecutor } = harness();
    // prompt Step 走可续接子代理：provider/model 走 llm 目录（L3）兜底，注册真实 childId。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    agents.register(child);
    ctx.provide('agents', agents);

    const executor = makeExecutor({ stageDef: stage, workflowDef: promptDef });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).not.toContain('## 任务规则');
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

  // 功能点 ②：finalize 提示词 <artifacts> 块含当前 Step 产物（context.artifacts 填充）
  it('finalize 门禁提示词 <artifacts> 块含当前 Step 产物（context.artifacts 填充，缺陷 16）', async () => {
    const { definition, stage } = singleShellDefinition();
    const stepWithGates: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'shell', value: { command: 'echo hi' } },
      outputTo: [{ id: 'report', path: 'out/report.md' }],
      passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
      gates: { primary: { enabled: true } },
    };
    const def: WorkflowDefinition = { ...definition, steps: [stepWithGates] };
    const { llm, fs, shell, makeExecutor } = harness();
    let call = 0;
    llm.streamHandler = () => {
      call += 1;
      // calls: [0] assess（needsAssess=true 因 ${v}）, [1] primary gate
      if (call === 1) return textChunks('{"completionType":"completed","passThroughVars":{}}');
      return textChunks('{"taskStatus":"done"}');
    };
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'hi', stderr: '' });
    fs.seedFile('/tmp/out/report.md');

    const executor = makeExecutor({ stageDef: stage, workflowDef: def });
    await executor.execute();

    // shell 无 prompt stream → calls = [assess, gate]
    expect(llm.calls).toHaveLength(2);
    const gatePrompt = textOf(llm.calls[1]?.messages[0]?.content[0]);
    expect(gatePrompt).toContain('<artifacts>');
    expect(gatePrompt).toContain('/tmp/out/report.md');
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
    const { ctx, llm, subagents, shell, fs, makeExecutor } = harness();
    // prompt Step（step-b）走可续接子代理：provider/model 走 llm 目录（L3）兜底，
    // 注册真实 childId 并回填最终输出。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'ok' }]));
    agents.register(child);
    ctx.provide('agents', agents);
    shell.runHandler = async () => ({ exitCode: 0, stdout: 'done', stderr: '' });
    fs.seedFile('/tmp/out/report.md');

    const executor = makeExecutor({ stageDef: twoStepStage, workflowDef: twoStepDef });
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    // step-a 是 shell（无 AI 调用）；step-b 是 prompt（startContinuable 提示词含前置产物）。
    // step-b 无 gates 无未解析透传变量 → finalize 跳过 → 无 assess/gate stream。
    expect(subagents.continuableStarts).toHaveLength(1);
    const promptText = textOf(subagents.continuableStarts[0]?.request.prompt[0]);
    expect(promptText).toContain('## 前置Steps输出与产物');
    expect(promptText).toContain('<artifacts>');
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
    const { ctx, llm, fs, makeExecutor } = harness();
    // 注册续跑的子代理（whenIdle 后取 final output）。
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    agents.register(child);
    ctx.provide('agents', agents);
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
    const { ctx, llm, subagents, shell, makeExecutor } = harness();
    // agent step 的 runAgentStep 需 resolveProviderModel → 配置 llm providers/models。
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 注册两个子代理，各自携带 assistant 输出（startContinuable 按 index 返回 child-1/child-2）。
    const agents = new FakeAgentRegistry();
    const child1 = new FakeAgent('child-1');
    child1.session.append(assistantMessageEvent([{ type: 'text', text: 'output A' }]));
    const child2 = new FakeAgent('child-2');
    child2.session.append(assistantMessageEvent([{ type: 'text', text: 'output B' }]));
    agents.register(child1);
    agents.register(child2);
    ctx.provide('agents', agents);

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
    const { llm, makeExecutor } = harness();
    let call = 0;
    llm.streamHandler = () => {
      // 首次评估判定需提问；回答后续跑重评估判定完成。
      const askJson = '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"确认继续？","options":[{"label":"A"}]}]}}';
      return textChunks(call++ === 0 ? askJson : '{"hasAsk":false,"passThroughVars":{}}');
    };
    // shell Step 声明未解析透传变量 → needsAssess（Phase A 跑评估）。
    const step: WorkflowStep = {
      id: 'step-sh',
      name: 'echo',
      command: { type: 'shell', value: { command: 'echo hi' } },
      passThroughVars: [{ name: 'v', value: '${v}', description: 'd' }],
    };
    const stage: WorkflowStage = { id: 'stg-1', name: 'Stage 1', steps: [{ id: 'step-sh' }] };
    const definition: WorkflowDefinition = {
      id: 'wfl-1', name: 'wfl-1', version: '1', stages: [stage], steps: [step], settings: {},
    };
    const executor = makeExecutor({ stageDef: stage, workflowDef: definition });

    // 首次 execute：Phase A ask 保底 → Step interacting + 实例 interacting（引擎 ask 闭环）。
    const first = await executor.execute();
    expect(first.status).toBe('interacting');
    expect(first.executedSteps[0]?.status).toBe('interacting');
    // Phase A 中断快照：currentPhase='ask-detect'，顶层 assessSessionId 不记录
    // （fork 用完即删不持久化；Phase B 收尾才落 assessSessionId）。
    expect(first.executedSteps[0]?.finalizeMeta?.currentPhase).toBe('ask-detect');
    expect(first.executedSteps[0]?.finalizeMeta?.assessSessionId).toBeUndefined();
    expect(first.executedSteps[0]?.finalizeMeta?.assessResult?.hasAsk).toBe(true);

    // 回答后再次 execute：resumePendingAsk（shell 无新 output，复用评估结果）→
    // Phase B（finalizeMeta currentPhase='finalizing'）→ Phase C（无门禁 ok）→ 完成。
    const second = await executor.execute();
    expect(second.status).toBe('completed');
    expect(second.executedSteps[0]?.status).toBe('completed');
    expect(second.executedSteps[0]?.finalizeMeta?.currentPhase).toBe('completed');
    // Phase B 起持久化 assessSessionId（评估 fork id）。
    expect(second.executedSteps[0]?.finalizeMeta?.assessSessionId).toMatch(/^eval-/);
  });
});
