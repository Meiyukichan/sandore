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
 * AI/shell）。`tryAdvanceStage` 在当前 Stage 完成后，按定义序评估 Stage 分支
 * `condition`：shell 条件本地逐条执行（`matchesExpectation(label)`）；AI 条件一次
 * 批量调用（`ctx.llm.stream` 一次性会话 + StageContract 作 context，对齐 Step 级
 * branch-evaluate-batch），返回满足条件的 branchId 数组。无 `condition` 分支为默认
 * （始终走，按位置参与竞争）；无命中按定义数组顺序兜底。Stage 级条件评估是 workflow
 * 级、基于 StageContract——Stage 无单一 step 会话可 fork（fork 是 Step 级），Stage
 * 条件基于聚合 StageContract 判断。
 * @module dsh-sandore/workflow/src/dag-navigator
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';

import { extractShouldExecuteBatch, matchesExpectation } from '../microflow/branch-evaluator';
import type { BranchEvaluatorConfig } from '../microflow/branch-evaluator';
import { describeError, escapeXml, resolveProviderModel, textSummary } from '../microflow/internal';

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

/** Stage 级条件分支评估提示词主头部（时序开场：当前 Stage 已执行完成，无角色声明）。 */
const STAGE_BRANCH_PROMPT_HEADER =
  '当前 Stage 已执行完成。请根据当前 Stage 的完成契约，判断下列分支中哪些满足其执行条件。';

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
   * 推进到下一 Stage（Stage 级条件分支批量评估）。
   *
   * 仅在当前 Stage 已完成（`isStageAllDone`）时推进。对当前 Stage 的 `branch`（Stage 级
   * 出边）按定义序分组评估：
   * ① 目标非 Stage 节点 → 跳过（Stage 路由只跟随 Stage 目标）；
   * ② 无 `condition`（默认分支）→ 恒通过（首个无 condition 位置）；
   * ③ shell 条件 → 本地逐条执行（命令各异不可合并），`matchesExpectation(label)` 判定；
   * ④ AI 条件 → **一次批量调用**（`ctx.llm.stream` 一次性会话，StageContract 摘要 +
   *    分支执行条件列表作 context，对齐 Step 级 branch-evaluate-batch），返回命中的
   *    branchId 数组。
   * 定义序首个命中者胜出（默认分支按位置参与竞争）；无命中按定义数组顺序推断下一
   * Stage。无下一 Stage 返回 false。
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
    const branches = current.branches ?? [];
    // 定义序分组：默认分支（无 condition，恒通过）、shell 条件（本地逐条）、AI 条件（批量一次）。
    const defaultIndexes: number[] = [];
    const shellCandidates: Array<{ branch: DagBranch; index: number }> = [];
    const aiCandidates: Array<{ branch: DagBranch; index: number }> = [];
    branches.forEach((branch, index) => {
      // Stage 路由只跟随 Stage 目标；非 Stage 目标（理论上 Stage 分支只指 Stage）跳过。
      if (!this.stageSet.has(branch.next)) {
        return;
      }
      if (branch.condition === undefined) {
        defaultIndexes.push(index);
      } else if (branch.condition.type === 'shell') {
        shellCandidates.push({ branch, index });
      } else {
        aiCandidates.push({ branch, index });
      }
    });
    // 命中集合（定义序 index）：首个默认分支恒通过；shell 逐条评估；AI 条件一次批量调用。
    const passed = new Set<number>();
    if (defaultIndexes.length > 0) {
      passed.add(defaultIndexes[0]!);
    }
    for (const { branch, index } of shellCandidates) {
      if (await this.evaluateStageShellBranch(branch, contract, signal)) {
        passed.add(index);
      }
    }
    if (aiCandidates.length > 0) {
      const passedIds = await this.evaluateStageAiBranchesBatch(
        aiCandidates.map(candidate => candidate.branch),
        contract,
        signal,
      );
      for (const { branch, index } of aiCandidates) {
        if (passedIds.includes(branch.next)) {
          passed.add(index);
        }
      }
    }
    // 定义序首个命中（默认分支按位置参与竞争，与逐条语义一致）。
    let nextId: string | undefined;
    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index]!;
      if (!this.stageSet.has(branch.next)) {
        continue;
      }
      if (passed.has(index)) {
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
   * 评估单个 Stage shell 条件分支（StageContract-based）。
   *
   * shell：经 `ctx.shell` 执行命令（StageContract 摘要作 stdin + 透传变量 env），成功取
   * stdout，`matchesExpectation(label)` 判定；失败（非零退出/超时/中止）降级为条件不通过。
   */
  private async evaluateStageShellBranch(
    branch: DagBranch,
    contract: StageContractValue | undefined,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const condition = branch.condition!;
    const contractSummary = contract === undefined ? '(无已完成的 Stage 契约)' : this.summarizeStageContract(contract);
    try {
      const output = await this.runStageShell(condition as Extract<CommandConfig, { type: 'shell' }>, contractSummary, signal);
      return matchesExpectation(output.trim(), branch.label);
    } catch (error) {
      // 评估失败（shell 非零退出/超时）：降级为条件不通过（走兜底）。
      this.ctx.logger.warn(`sandore: stage shell branch condition evaluation failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Stage AI 条件分支批量评估入口：一次调用评估所有 AI 条件分支（对齐 Step 级
   * branch-evaluate-batch）。会话失败/解析失败整批降级（warn 一次 + 空数组 → 条件不通过）。
   */
  private async evaluateStageAiBranchesBatch(
    branches: readonly DagBranch[],
    contract: StageContractValue | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const contractSummary = contract === undefined ? '(无已完成的 Stage 契约)' : this.summarizeStageContract(contract);
    try {
      return await this.runStageAiBatch(branches, contractSummary, signal);
    } catch (error) {
      this.ctx.logger.warn(`sandore: stage AI branch conditions evaluation failed: ${describeError(error)}`);
      return [];
    }
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

  /** shell 结果 → stdout；非零退出/超时/中止抛错（由 evaluateStageShellBranch 捕获降级）。 */
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
   * Stage AI 条件批量评估：`ctx.llm.stream` 一次性会话（一次调用评估所有 AI 条件分支）。
   *
   * 不 fork（Stage 无单一 step 会话可 fork）——一次性会话，StageContract 摘要 + 分支
   * 执行条件列表拼进提示词作 context。provider/model 三层回退（首个 AI 分支条件定义 →
   * 引擎配置 → ctx.llm 目录兜底，对齐 Step 级批量评估）。输出聚合后提取命中的
   * branchId 数组；解析失败（undefined）→ 空数组（整批条件不通过，走兜底）。
   */
  private async runStageAiBatch(
    branches: readonly DagBranch[],
    contractSummary: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const value = (branches[0]!.condition!.value as AiConditionValue);
    const route = await resolveProviderModel(value, this.config, this.ctx.llm);
    const promptText = this.buildStageBatchBranchPrompt(branches, contractSummary);
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
    const output = textSummary(assembler.blocks());
    return extractShouldExecuteBatch(output) ?? [];
  }

  /**
   * 构造 Stage 分支批量评估提示词（v6：时序开场 + 四点 + 参考信息 + 分支执行条件 +
   * 返回格式）。
   *
   * 批量评估所有 AI 条件分支（一次 llm 调用）；shell 条件不经此（本地执行）。分支执行
   * 条件列表（branchId + executeCondition）以 JSON 给出，executeCondition 取自各分支 AI
   * 条件命令的 promptText；StageContract 摘要经 escapeXml 转义后以 `<ReferenceInfo>` 注入
   * （必注入——一次性会话无 fork 历史，摘要是唯一判断依据）。无红线节：一次性会话
   * （`llm.stream`）无工具，禁止类约束为空话（同 Phase A 原则）。
   */
  private buildStageBatchBranchPrompt(branches: readonly DagBranch[], contractSummary: string): string {
    const sections: string[] = [STAGE_BRANCH_PROMPT_HEADER];
    sections.push('');
    sections.push('必须先明确以下四点，再开始执行：');
    sections.push('- `## 你的任务` —— 本次 Stage 路由判断要达成的**唯一目标**。');
    sections.push('- `## 分支执行条件` —— 需要判断的分支及其执行条件。');
    sections.push('- `## 参考信息` —— 当前 Stage 的完成契约，按需查阅。');
    sections.push('- `## 返回格式` —— 必须返回的 JSON 格式。');
    sections.push('');
    sections.push('## 你的任务');
    sections.push('根据 `## 分支执行条件` 与 `## 参考信息` 中当前 Stage 的完成契约，判断哪些分支满足其执行条件。**唯一目标**：找出所有满足执行条件的分支，返回其 branchId 列表。');
    sections.push('');
    sections.push('## 参考信息');
    sections.push('<ReferenceInfo>');
    sections.push('  <Reference title="当前 Stage 完成契约">');
    sections.push(escapeXml(contractSummary));
    sections.push('  </Reference>');
    sections.push('</ReferenceInfo>');
    sections.push('');
    sections.push('## 分支执行条件');
    sections.push('```json');
    sections.push(JSON.stringify(branches.map(branch => ({
      branchId: branch.next,
      executeCondition: (branch.condition!.value as AiConditionValue).promptText,
    })), null, 2));
    sections.push('```');
    sections.push('');
    sections.push('## 返回格式');
    sections.push('请仅返回 JSON，格式如下：');
    sections.push('```json');
    sections.push('{"shouldExecute": ["branchId1", "branchId2"]}');
    sections.push('```');
    sections.push('其中，`shouldExecute` 为满足其 `executeCondition` 条件的分支的 `branchId` 列表；没有任何分支满足时返回空数组 `[]`。');
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
