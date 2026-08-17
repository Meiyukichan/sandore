/**
 * RunView 的可测纯逻辑（无 React 依赖）。
 *
 * 从 `@deepseek-ai/dsh-sandore-workflow/schema`（浏览器安全子路径）导入
 * `WorkflowTaskState` 等 wire 类型，并以其派生 `DagRunStatus`/`StepStatus`/
 * `ExecutedStep`/`StageInfo`（避免从包根 `types.ts` 导入带出 `dsh-llm` 依赖）。
 * 此处提供：7 态 → StateDotState 穷尽映射、运行中/终态判定（驱动 5s 轮询）、
 * pending 交互分类、retry message 校验与 `RetryMode` 词汇。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-model
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState,
} from '@deepseek-ai/dsh-sandore-workflow/schema'

/** 实例生命周期状态（从 `WorkflowTaskState` 派生，避免 dsh-llm 依赖）。 */
export type DagRunStatus = WorkflowTaskState['status']

/** 单个 Step/Stage 执行状态（从 `WorkflowTaskState` 派生）。 */
export type StepStatus = WorkflowTaskState['executedSteps'][number]['status']

/** 已执行 Step 的快照（从 `WorkflowTaskState` 派生）。 */
export type ExecutedStep = WorkflowTaskState['executedSteps'][number]

/** Stage 状态快照（从 `WorkflowTaskState` 派生）。 */
export type StageInfo = WorkflowTaskState['stageInfos'][number]

/** 重试模式（对齐 `retryStep` 入参 `mode` 的 zod 枚举）。 */
export type RetryMode = 'continue' | 'revert' | 'fork'

/** 三种重试模式（供重试表单下拉/选项渲染）。 */
export const RETRY_MODES: readonly RetryMode[] = ['continue', 'revert', 'fork']

/**
 * StepStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（等待用户注意的
 * blocked/ready/interacting/paused）折入 `warning`。
 * @param status - Step 执行状态。
 * @returns 四态语义点。
 */
export function stepDotState(status: StepStatus): StateDotState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'running':
      return 'ongoing'
    case 'blocked':
    case 'ready':
    case 'interacting':
    case 'paused':
      return 'warning'
  }
}

/**
 * DagRunStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（pending/interacting/
 * aborted/paused）折入 `warning`。
 * @param status - 实例生命周期状态。
 * @returns 四态语义点。
 */
export function runDotState(status: DagRunStatus): StateDotState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'running':
      return 'ongoing'
    case 'pending':
    case 'interacting':
    case 'aborted':
    case 'paused':
      return 'warning'
  }
}

/**
 * 实例是否处于「运行中」状态（`running`/`interacting`），决定是否启动 5s 轮询。
 * @param status - 实例生命周期状态。
 * @returns 运行中（需轮询）为 true。
 */
export function isRunningStatus(status: DagRunStatus): boolean {
  return status === 'running' || status === 'interacting'
}

/**
 * 实例是否已进入终态（`completed`/`failed`/`aborted`），终态停止轮询。
 * @param status - 实例生命周期状态。
 * @returns 终态为 true。
 */
export function isTerminalStatus(status: DagRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

/** pending 交互分类结果。 */
export interface PendingInteractionPartition {
  /** 待答问题条目。 */
  readonly questions: readonly PendingQuestionEntry[]
  /** 待批权限条目。 */
  readonly permissions: readonly PendingPermissionEntry[]
}

/**
 * 按 `kind` 把 `pendingInteractions` 分为问答与权限两组。
 * @param interactions - 实例的 pending 交互列表。
 * @returns 问答与权限两个分组。
 */
export function partitionInteractions(
  interactions: readonly (PendingQuestionEntry | PendingPermissionEntry)[],
): PendingInteractionPartition {
  const questions: PendingQuestionEntry[] = []
  const permissions: PendingPermissionEntry[] = []
  for (const interaction of interactions) {
    if (interaction.kind === 'question') {
      questions.push(interaction)
    } else {
      permissions.push(interaction)
    }
  }
  return { questions, permissions }
}

/**
 * 判断字符串是否为空或仅含空白（用于 retry message 等必填文本校验）。
 * @param value - 待校验文本。
 * @returns 空白为 true。
 */
export function isBlank(value: string): boolean {
  return value.trim() === ''
}

/**
 * Step 对外交互标识：定义 `stepId` 优先，缺省回退唯一执行 `id`。
 * 与引擎侧 `findStep`（先 `stepId` 后 `id` 反查）保持一致，供
 * `pauseStep`/`resumeStep`/`retryStep` 入参使用。
 * @param step - 含 `id` 与可选 `stepId` 的 Step 快照。
 * @returns 可反查该 Step 的稳定标识。
 */
export function stepIdOf(step: { readonly id: string; readonly stepId?: string | undefined }): string {
  return step.stepId ?? step.id
}

/**
 * 判定 Step 是否为可续接的子代理 Step（agent/skill/mcp），非 shell/prompt 合成 session。
 *
 * 对齐引擎侧 `recovery-manager.ts` 的 `isSubagentStep`：优先 `sessionMeta.command`
 * （运行时 session 元数据），缺省回退 `command.type`（定义态命令类型）。shell/prompt
 * 合成 session 无真实子代理，引擎对暂停/重试明确抛 `INVALID_OPERATION`，故 UI 不应
 * 对其渲染 pause/resume/retry 控件。
 * @param step - 已执行 Step 快照。
 * @returns 子代理 Step（可暂停/恢复/重试）为 true。
 */
export function isSubagentStep(step: ExecutedStep): boolean {
  const command = step.sessionMeta?.command ?? step.command?.type
  return command === 'agent' || command === 'skill' || command === 'mcp'
}

// ── 树形导航 / 统一时间线派生（纯函数，无 React 依赖） ─────────────────────

/** 树形导航节点类型。 */
export type RunTreeNodeType = 'workflow' | 'stage' | 'step' | 'result' | 'artifact'

/** 树形导航节点。 */
export interface RunTreeNode {
  readonly id: string
  readonly name: string
  readonly type: RunTreeNodeType
  /** 节点状态（workflow 为实例生命周期态；stage/step 为 Step 态；叶子无）。 */
  readonly status?: StepStatus | DagRunStatus | undefined
  /** 归属 Step 的稳定标识（stepIdOf；供预览/操作反查）。 */
  readonly stepId?: string | undefined
  /** 子代理会话 id（sessionMeta.childId，供「跳子会话」）。 */
  readonly childId?: string | undefined
  /** 副信息（artifact 的 outputToId / 文件路径）。 */
  readonly meta?: string | undefined
  /** 预览正文（result 的输出文本 / artifact 的文件路径）。 */
  readonly text?: string | undefined
  readonly children?: readonly RunTreeNode[] | undefined
}

/** 统一时间线的 Step 卡片项。 */
export interface TimelineStepItem {
  readonly kind: 'step'
  readonly stepId: string
  readonly name: string
  readonly status: StepStatus
  /** 循环迭代标签（如 `#1.2`）。 */
  readonly loopLabel?: string | undefined
  /** completed 态输出文本（text 块拼接）。 */
  readonly outputText?: string | undefined
  /** failed 态错误详情。 */
  readonly error?: string | undefined
  /** 子代理会话 id（跳「查看详情」）。 */
  readonly childId?: string | undefined
  readonly visitCount: number
}

/** 统一时间线的用户气泡项。 */
export interface TimelineUserItem {
  readonly kind: 'user'
  readonly content: string
}

/** 统一时间线条目（Step 卡片 / 用户气泡，按时间顺序）。 */
export type TimelineItem = TimelineStepItem | TimelineUserItem

/**
 * 把 `output: ContentBlock[]` 的 text 块拼接为纯文本（无 text 块返回 undefined）。
 * @param output - Step 执行输出块（引擎在 step-completed 事件/快照中内联）。
 * @returns 拼接文本或 undefined。
 */
export function outputTextOf(output: readonly { readonly type: string; readonly text?: string }[] | undefined): string | undefined {
  if (output === undefined || output.length === 0) return undefined
  const parts: string[] = []
  for (const block of output) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 循环迭代路径 → 展示标签（`#1.2`），非循环返回 undefined。 */
export function loopLabelOf(loopIteration: readonly number[] | undefined): string | undefined {
  return loopIteration === undefined || loopIteration.length === 0
    ? undefined
    : `#${loopIteration.join('.')}`
}

/**
 * 从 `WorkflowTaskState` 构建树形导航数据：workflow → stage → step → result/artifact 叶子。
 * result 叶子来自 step 输出文本；artifact 叶子来自 `stageContracts` 产物契约的 files。
 * @param state - 实例状态快照。
 * @returns 树形导航根节点列表（单个 workflow 根）。
 */
export function buildRunTree(state: WorkflowTaskState): RunTreeNode[] {
  // 叶子按「定义 stepId」分组（artifact.stepId 为定义 id；step 用 stepIdOf 对齐）。
  const leavesByStepId = new Map<string, RunTreeNode[]>()
  for (const step of state.executedSteps) {
    const output = outputTextOf(step.output)
    if (output === undefined) continue
    const key = stepIdOf(step)
    const current = leavesByStepId.get(key) ?? []
    leavesByStepId.set(key, [...current, { id: `${step.id}:result`, name: '', type: 'result', stepId: key, text: output }])
  }
  for (const contract of Object.values(state.stageContracts)) {
    for (const artifact of contract.artifacts) {
      for (const file of artifact.files) {
        const current = leavesByStepId.get(artifact.stepId) ?? []
        leavesByStepId.set(artifact.stepId, [...current, {
          id: `${artifact.stepId}:file:${file}`,
          name: file,
          type: 'artifact',
          stepId: artifact.stepId,
          meta: artifact.outputToId,
          text: file,
        }])
      }
    }
  }

  const stageNodes = state.stageInfos.map(stage => {
    const steps = state.executedSteps.filter(step => step.stageId === stage.id)
    return {
      id: stage.id,
      name: stage.name,
      type: 'stage' as const,
      status: stage.status,
      children: steps.map(step => {
        const key = stepIdOf(step)
        return {
          id: step.id,
          name: step.name,
          type: 'step' as const,
          status: step.status,
          stepId: key,
          childId: step.sessionMeta?.childId,
          children: leavesByStepId.get(key),
        }
      }),
    }
  })

  return [{
    id: state.workflowId,
    name: state.workflowId,
    type: 'workflow' as const,
    status: state.status,
    children: stageNodes,
  }]
}

/**
 * 从 `WorkflowTaskState` 构建统一时间线：初始输入 user 气泡 + 各 executedStep 卡片
 * （按执行顺序）。running 卡无实时消息流（引擎不写 sessionMessages、无 step-message
 * 事件），body 按状态展示输出文本 / 错误 / 运行中占位。
 * @param state - 实例状态快照。
 * @returns 时间线条目列表。
 */
export function buildTimeline(state: WorkflowTaskState): TimelineItem[] {
  const items: TimelineItem[] = []
  if (state.originalInput !== '') {
    items.push({ kind: 'user', content: state.originalInput })
  }
  for (const step of state.executedSteps) {
    items.push({
      kind: 'step',
      stepId: stepIdOf(step),
      name: step.name,
      status: step.status,
      loopLabel: loopLabelOf(step.loopIteration),
      outputText: outputTextOf(step.output),
      error: step.error,
      childId: step.sessionMeta?.childId,
      visitCount: step.visitCount,
    })
  }
  return items
}
