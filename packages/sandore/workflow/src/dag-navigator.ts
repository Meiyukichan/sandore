/**
 * 工作流 DAG 导航器（Stage 级编排）。
 *
 * **包职责边界（用户原则）**：workflow 只管 Stage——Stage→Stage 推进 + Stage 级编排 +
 * 引擎 + Host RPC。本导航器持有 Stage 节点索引 `stageIndex`（Stage 节点图）、
 * `stageContracts`（已完成 Stage 契约）、当前 Stage 指针，承担 Stage 级路由：
 * {@link WorkflowDagNavigator.tryAdvanceStage} 基于 Stage `branch.condition` 评估选
 * 下一 Stage（StageContract-based，**非 fork-based**）。
 *
 * **Step 级路由已迁 microflow**：`resolveNextNodes`（循环/条件/并行分支算下一批 Step）
 * + 循环计数 + 判断 + 收尾全归 microflow 的 `StepNavigator`。一个 Stage 内部执行
 * （含 Step 路由）自包含在 microflow 完成，才到本导航器 `tryAdvanceStage` 推进下一
 * Stage。
 *
 * **Stage 级条件分支**：`WorkflowStage.branches` 可带 `condition`（CommandConfig：
 * AI/shell）。`tryAdvanceStage` 在当前 Stage 完成后，对每个 Stage 分支评估 `condition`
 * （AI 走 `ctx.llm.stream` 一次性会话 + StageContract 作 context；shell 走
 * `matchesExpectation(label)`），命中条件的目标 Stage；无 `condition` 分支为默认
 * （始终走）；无命中按定义数组顺序兜底。Stage 级条件评估是 workflow 级、基于
 * StageContract——Stage 无单一 step 会话可 fork（fork 是 Step 级），Stage 条件基于
 * 聚合 StageContract 判断。
 * @module @deepseek-ai/dsh-sandore-workflow/src/dag-navigator
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';

import { extractShouldExecute, matchesExpectation } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import type { BranchEvaluatorConfig } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import { describeError, resolveProviderModel, textSummary } from '@deepseek-ai/dsh-sandore-microflow/src/internal';

import type { CommandConfig, DagBranch, WorkflowDefinition, WorkflowStage, WorkflowTaskState } from './schema.ts';
import type { ShellExecRequest, ShellRunResult } from './shell.ts';
import type { StageContract } from './types.ts';

/** 已保存 Stage 契约的运行时形状（与快照 `stageContracts` 值严格一致）。 */
type StageContractValue = WorkflowTaskState['stageContracts'][string];

/** AI 条件评估命令的 value 取值域（provider/model 三层回退）。 */
type AiConditionValue = { readonly promptText: string; readonly providerId?: string; readonly modelId?: string };
/** shell 条件评估命令的 value。 */
type ShellConditionValue = { readonly command: string };

/** Stage 节点视图（出边统一在 branches；Stage 级路由唯一目标单元）。 */
export interface StageNodeRef {
  readonly stage: WorkflowStage;
  readonly id: string;
  readonly name: string;
  readonly branches?: DagBranch[] | undefined;
}

/** 导航器初始化播种（崩溃恢复/重试续跑时从快照重建执行位置）。 */
export interface DagNavigatorSeed {
  /** 起始 Stage（从快照 `currentStageId` 播种，缺省为定义首个 Stage）。 */
  readonly currentStageId?: string;
  /** 已完成 Stage 契约（从快照 `stageContracts` 播种）。 */
  readonly stageContracts?: Readonly<Record<string, StageContractValue>>;
}

/** Stage 级条件分支评估提示词主头部。 */
const STAGE_BRANCH_PROMPT_HEADER =
  '你是严谨准确的工作流 Stage 路由 Agent，你的任务是根据当前 Stage 的完成契约与分支条件，判断是否应推进到该分支的目标 Stage。';

/** Stage 条件评估红线规则（只读，禁止文件改动与过度思考）。 */
const STAGE_BRANCH_RED_LINES = [
  '禁止编辑、创建或删除任何文件',
  '禁止过度思考，你的职责是尽快判断分支并返回结果',
] as const;

/**
 * 工作流 DAG 导航器（Stage 级）。
 *
 * 保存 `stageIndex`（stageId → Stage 节点视图）、`stageContracts`（已完成 Stage 契约）、
 * 当前 Stage 指针。`tryAdvanceStage` 基于 StageContract 评估 Stage `branch.condition`
 * 选下一 Stage。Step 级路由/循环已不在本导航器（归 microflow `StepNavigator`）。
 */
export class WorkflowDagNavigator {
  private readonly stageIndex = new Map<string, StageNodeRef>();
  private readonly stageSet: ReadonlySet<string>;
  private readonly stageContracts = new Map<string, StageContractValue>();
  private readonly stageOrder: readonly string[];
  private currentStageId: string;
  private readonly ctx: Context;
  private readonly config: BranchEvaluatorConfig;
  private readonly cwd: string;

  constructor(
    definition: WorkflowDefinition,
    ctx: Context,
    config: BranchEvaluatorConfig,
    cwd: string,
    seed?: DagNavigatorSeed,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.cwd = cwd;
    this.buildStageIndex(definition);
    this.stageSet = new Set(definition.stages.map(stage => stage.id));
    this.stageOrder = definition.stages.map(stage => stage.id);
    // 从快照播种当前 Stage（续跑入口）；缺省回退定义首个 Stage。
    this.currentStageId = seed?.currentStageId ?? this.stageOrder[0] ?? '';
    if (seed?.stageContracts !== undefined) {
      for (const [id, contract] of Object.entries(seed.stageContracts)) {
        this.stageContracts.set(id, contract);
      }
    }
  }

  /** 当前 Stage ID（无 Stage 时为空字符串）。 */
  get currentNodeId(): string {
    return this.currentStageId;
  }

  /** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
  getStageContracts(): ReadonlyMap<string, StageContractValue> {
    return new Map(this.stageContracts);
  }

  /** 查询单个 Stage 的契约。 */
  getStageContract(stageId: string): StageContractValue | undefined {
    return this.stageContracts.get(stageId);
  }

  /** 聚合前置 Stage 的契约产物（供后续 Stage 引用）。 */
  getContractArtifacts(): Record<string, string[]> {
    const merged: Record<string, string[]> = {};
    for (const contract of this.stageContracts.values()) {
      for (const [name, files] of Object.entries(contract.contractArtifacts)) {
        merged[name] = [...(merged[name] ?? []), ...files];
      }
    }
    return merged;
  }

  /** 保存 Stage 完成契约。 */
  setStageContract(stageId: string, contract: StageContract): void {
    this.stageContracts.set(stageId, contract);
  }

  /** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
  isStageAllDone(stageId: string): boolean {
    return this.stageContracts.get(stageId)?.status === 'completed';
  }

  /**
   * 推进到下一 Stage（Stage 级条件分支评估）。
   *
   * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：对当前 Stage 的每个 `branch`
   * （Stage 级出边）：
   * ① 目标非 Stage 节点 → 跳过（Stage 路由只跟随 Stage 目标）；
   * ② 无 `condition`（默认分支）→ 直接取该目标（首个有效 Stage 目标）；
   * ③ 有 `condition` → 基于 StageContract 评估（AI 一次性会话 + StageContract context；
   *    shell 走 `matchesExpectation(label)`），命中取该目标；
   * 无命中按定义数组顺序推断下一 Stage。无下一 Stage 返回 false。
   *
   * Stage 级条件评估是 workflow 级、基于 StageContract——**不是 fork-based**（Stage 无
   * 单一 step 会话可 fork；Stage 条件基于聚合 StageContract 判断）。
   */
  async tryAdvanceStage(signal?: AbortSignal): Promise<boolean> {
    if (!this.isStageAllDone(this.currentStageId)) {
      return false;
    }
    const current = this.stageIndex.get(this.currentStageId);
    if (current === undefined) {
      return false;
    }
    const contract = this.getStageContract(this.currentStageId);
    let nextId: string | undefined;
    for (const branch of current.branches ?? []) {
      // Stage 路由只跟随 Stage 目标；非 Stage 目标（理论上 Stage 分支只指 Stage）跳过。
      if (!this.stageSet.has(branch.next)) {
        continue;
      }
      if (branch.condition === undefined) {
        // 无 condition = 默认分支，始终走（首个有效 Stage 目标）。
        nextId = branch.next;
        break;
      }
      const passed = await this.evaluateStageBranch(branch, contract, signal);
      if (passed) {
        nextId = branch.next;
        break;
      }
    }
    if (nextId === undefined) {
      const index = this.stageOrder.indexOf(current.id);
      nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
    }
    if (nextId === undefined || !this.stageSet.has(nextId)) {
      return false;
    }
    this.currentStageId = nextId;
    return true;
  }

  /**
   * 评估单个 Stage 分支的 `condition` 是否通过（StageContract-based）。
   *
   * shell：经 `ctx.shell` 执行命令（StageContract 摘要作 stdin + 透传变量 env），成功取
   * stdout，失败降级为空串（→ 条件不通过）；AI（agent/prompt/skill/mcp）：`ctx.llm.stream`
   * 一次性会话（StageContract 摘要 + 分支条件作 context），聚合输出后提取 shouldExecute。
   */
  private async evaluateStageBranch(
    branch: DagBranch,
    contract: StageContractValue | undefined,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const condition = branch.condition!;
    const contractSummary = contract === undefined ? '(无已完成的 Stage 契约)' : this.summarizeStageContract(contract);
    try {
      const output = condition.type === 'shell'
        ? await this.runStageShell(condition, contractSummary, signal)
        : await this.runStageAi(condition, contractSummary, signal);
      return this.decideStageCondition(condition, output, branch.label);
    } catch (error) {
      // 评估失败（shell 非零退出/超时、AI 会话错误）：降级为条件不通过（走兜底）。
      this.ctx.logger.warn(`sandore: stage branch condition evaluation failed: ${describeError(error)}`);
      return false;
    }
  }

  /** 按 condition 类型判定 Stage 分支是否通过（shell 匹配 label；AI 提取 shouldExecute）。 */
  private decideStageCondition(condition: CommandConfig, output: string, expectation: string | undefined): boolean {
    if (condition.type === 'shell') {
      if (expectation === undefined) {
        return false;
      }
      return matchesExpectation(output.trim(), expectation);
    }
    // AI 条件：提取 shouldExecute 布尔（与 Stage 分支提示词要求的 JSON 格式对齐）；
    // 解析失败（undefined）按 false 处理——条件分支不通过，走兜底。
    return extractShouldExecute(output) === true;
  }

  /** Stage shell 条件：经 `ctx.shell` 执行命令，StageContract 摘要作 stdin。 */
  private async runStageShell(
    condition: Extract<CommandConfig, { type: 'shell' }>,
    contractSummary: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const request: ShellExecRequest = {
      command: condition.value.command,
      timeoutMs: this.config.defaultTimeoutMs,
      workdir: this.cwd,
      stdin: contractSummary,
      ...(signal === undefined ? {} : { signal }),
    };
    const spec = this.ctx.shell.resolve(request);
    const result = await this.ctx.shell.run(spec);
    return this.toStdout(result);
  }

  /** shell 结果 → stdout；非零退出/超时/中止抛错（由 evaluateStageBranch 捕获降级）。 */
  private toStdout(result: ShellRunResult): string {
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
      return result.stdout.text;
    }
    const stderr = result.stderr.text.trim();
    const stderrSummary = stderr === '' ? '(no stderr)' : stderr;
    if (result.timedOut) {
      throw new Error(`stage shell condition timed out: ${stderrSummary}`);
    }
    const reason = result.aborted
      ? 'aborted'
      : `exited with code ${result.exitCode === null ? 'signal' : String(result.exitCode)}`;
    throw new Error(`stage shell condition ${reason}: ${stderrSummary}`);
  }

  /**
   * Stage AI 条件：`ctx.llm.stream` 一次性会话（StageContract 摘要 + 分支条件作 context）。
   *
   * 不 fork（Stage 无单一 step 会话可 fork）——一次性会话，StageContract 摘要拼进提示词
   * 作 context。provider/model 三层回退（条件定义 → 引擎配置 → ctx.llm 目录兜底）。
   */
  private async runStageAi(
    condition: Extract<CommandConfig, { type: 'agent' | 'prompt' | 'skill' | 'mcp' }>,
    contractSummary: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const value = condition.value as AiConditionValue;
    const route = await resolveProviderModel(value, this.config, this.ctx.llm);
    const promptText = this.buildStageBranchPrompt(value.promptText, contractSummary);
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: promptText }],
    });
    const messages: Message[] = [message];
    const generateOptions: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      ...(signal === undefined ? {} : { signal }),
    };
    const assembler = new BlockAssembler();
    const stream = this.ctx.llm.stream(generateOptions);
    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      assembler.push(chunk);
    }
    return textSummary(assembler.blocks());
  }

  /** 构造 Stage 分支评估提示词（主头部 + 任务 + Stage 契约 context + 返回格式 + 红线）。 */
  private buildStageBranchPrompt(taskText: string, contractSummary: string): string {
    const sections: string[] = [STAGE_BRANCH_PROMPT_HEADER];
    sections.push('');
    sections.push('## 你的任务');
    sections.push(taskText);
    sections.push('');
    sections.push('## 当前 Stage 完成契约');
    sections.push(contractSummary);
    sections.push('');
    sections.push('## 返回格式');
    sections.push('请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否应推进到该分支的目标 Stage。');
    sections.push('');
    sections.push('## 红线规则');
    for (const rule of STAGE_BRANCH_RED_LINES) {
      sections.push(`- ${rule}`);
    }
    return sections.join('\n');
  }

  /**
   * 汇总 Stage 契约为紧凑文本（供 AI context / shell stdin）。
   *
   * 含 Stage 名/状态/产物（stepId → returnPrompt 摘要）/ 透传变量。避免全量 JSON 转储。
   */
  private summarizeStageContract(contract: StageContractValue): string {
    const lines: string[] = [];
    lines.push(`Stage: ${contract.stageName}（${contract.stageId}）`);
    lines.push(`状态: ${contract.status}`);
    if (contract.errorDetail !== undefined) {
      lines.push(`错误: ${contract.errorDetail}`);
    }
    if (contract.artifacts.length > 0) {
      lines.push('产物:');
      for (const artifact of contract.artifacts) {
        const prompt = artifact.returnPrompt === undefined ? '(无文本摘要)' : artifact.returnPrompt;
        lines.push(`- step ${artifact.stepId} → ${artifact.outputToId}: ${prompt}`);
      }
    }
    const vars = Object.entries(contract.passThroughVars);
    if (vars.length > 0) {
      lines.push('透传变量:');
      for (const [name, value] of vars) {
        lines.push(`- ${name}: ${value.value}`);
      }
    }
    return lines.join('\n');
  }

  private buildStageIndex(definition: WorkflowDefinition): void {
    for (const stage of definition.stages) {
      this.stageIndex.set(stage.id, {
        stage,
        id: stage.id,
        name: stage.name,
        branches: stage.branches,
      });
    }
  }
}
