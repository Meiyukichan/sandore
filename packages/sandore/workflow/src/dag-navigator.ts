/**
 * 工作流 DAG 导航器（Task 2 简化：仅 Stage 级线性推进）。
 *
 * 构建 Stage/Step 统一节点索引 `nodeIndex`，`tryAdvanceStage()` 在当前 Stage
 * 完成后跟随 `Stage.next`（无 `next` 时按定义数组顺序推断下一 Stage），并保存
 * 每个已完成 Stage 的 `StageContract`。分支/循环调度留待后续 Task。
 * @module @deepseek-ai/dsh-sandore-workflow/src/dag-navigator
 */
import type { CommandConfig, DagBranch, DagLoop, WorkflowDefinition, WorkflowStage, WorkflowStep } from './schema.ts';
import type { StageContract } from './types.ts';

/** Stage 与 Step 在 DAG 调度层的统一节点视图。 */
export interface DagNodeRef {
  readonly kind: 'stage' | 'step';
  /** 所属 Stage（始终可用）。 */
  readonly stage: WorkflowStage;
  /** 仅 kind === 'step' 时存在。 */
  readonly step?: WorkflowStep | undefined;
  readonly id: string;
  readonly name: string;
  readonly next?: string | undefined;
  readonly condition?: CommandConfig | undefined;
  readonly branches?: DagBranch[] | undefined;
  readonly loop?: DagLoop | undefined;
}

/**
 * 工作流 DAG 导航器。
 *
 * 保存 `nodeIndex`（nodeId → 统一节点视图）、`stageContracts`（已完成 Stage
 * 契约）与当前 Stage 指针，并提供 `tryAdvanceStage()` 线性推进。
 */
export class WorkflowDagNavigator {
  private readonly nodeIndex = new Map<string, DagNodeRef>();
  private readonly stageContracts = new Map<string, StageContract>();
  private readonly stageOrder: readonly string[];
  private currentStageId: string;

  constructor(private readonly definition: WorkflowDefinition) {
    this.buildNodeIndex(definition);
    this.stageOrder = definition.stages.map(stage => stage.id);
    this.currentStageId = this.stageOrder[0] ?? '';
  }

  /** 当前 Stage ID（无 Stage 时为空字符串）。 */
  get currentNodeId(): string {
    return this.currentStageId;
  }

  /** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
  getStageContracts(): ReadonlyMap<string, StageContract> {
    return new Map(this.stageContracts);
  }

  /** 查询单个 Stage 的契约。 */
  getStageContract(stageId: string): StageContract | undefined {
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

  /** 当前 Stage 是否已全部完成（Task 2：以已存契约的 completed 状态判定）。 */
  isStageAllDone(stageId: string): boolean {
    return this.stageContracts.get(stageId)?.status === 'completed';
  }

  /**
   * 推进到下一 Stage。
   *
   * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的
   * `next`，否则按定义数组顺序推断下一 Stage。无下一 Stage 返回 false。
   * @returns 是否有下一 Stage 可继续执行。
   */
  tryAdvanceStage(): boolean {
    if (!this.isStageAllDone(this.currentStageId)) {
      return false;
    }
    const current = this.nodeIndex.get(this.currentStageId);
    if (current === undefined || current.kind !== 'stage') {
      return false;
    }
    let nextId: string | undefined = current.next;
    if (nextId === undefined) {
      const index = this.stageOrder.indexOf(current.id);
      nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
    }
    const next = nextId === undefined ? undefined : this.nodeIndex.get(nextId);
    if (next === undefined || next.kind !== 'stage') {
      return false;
    }
    this.currentStageId = next.id;
    return true;
  }

  private buildNodeIndex(definition: WorkflowDefinition): void {
    for (const stage of definition.stages) {
      this.nodeIndex.set(stage.id, {
        kind: 'stage',
        stage,
        id: stage.id,
        name: stage.name,
        next: stage.next,
        condition: stage.condition,
        branches: stage.branches,
        loop: stage.loop,
      });
      for (const step of stage.steps) {
        this.nodeIndex.set(step.id, {
          kind: 'step',
          stage,
          step,
          id: step.id,
          name: step.name ?? step.id,
          next: step.next,
          condition: step.condition,
          branches: step.branches,
          loop: step.loop,
        });
      }
    }
  }
}
