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
import type { RevertBoundaryOption } from '@deepseek-ai/dsh-sandore-workflow/types'

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

/** revert 回退点候选（对齐 `listRevertBoundaries` 返回的 `RevertBoundaryOption`）。 */
export type { RevertBoundaryOption }

/** replyQuestion 单个问题的回答（对齐 Host 的 `AskUserQuestionAnswerItem`）。 */
export interface AnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

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
 *
 * 探索修正（2026-08）：仅取 `status === 'pending'` 的条目——后端已只持久化 pending，
 * 此处过滤是防御旧快照（含 replied/rejected 全量历史时避免讨论页复弹接管面板）。
 * @param interactions - 实例的 pending 交互列表。
 * @returns 问答与权限两个分组。
 */
export function partitionInteractions(
  interactions: readonly (PendingQuestionEntry | PendingPermissionEntry)[],
): PendingInteractionPartition {
  const questions: PendingQuestionEntry[] = []
  const permissions: PendingPermissionEntry[] = []
  for (const interaction of interactions) {
    if (interaction.status !== 'pending') continue
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
 * 判定 Step 是否为可续接的子代理 Step（agent/skill/mcp/prompt），非 shell 合成 session。
 *
 * 对齐引擎侧 `recovery-manager.ts` 的 `isSubagentStep`：优先 `sessionMeta.command`
 * （运行时 session 元数据），缺省回退 `command.type`（定义态命令类型）。shell
 * 合成 session 无真实子代理，引擎对暂停/重试明确抛 `INVALID_OPERATION`，故 UI 不应
 * 对其渲染 pause/resume/retry 控件；prompt 为真实子代理会话（决策 D3），与
 * agent/skill/mcp 同语义。
 * @param step - 已执行 Step 快照。
 * @returns 子代理 Step（可暂停/恢复/重试）为 true。
 */
export function isSubagentStep(step: ExecutedStep): boolean {
  const command = step.sessionMeta?.command ?? step.command?.type
  return command === 'agent' || command === 'skill' || command === 'mcp' || command === 'prompt'
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

/** agent 内嵌消息框的展示行（who + 正文 + 类型）。 */
export interface ChatLine {
  /** 行归属（`{stepName} · agent` / `{stepName} · tool`）。 */
  readonly who: string
  /** 行正文（pre-wrap）。 */
  readonly text: string
  /** assistant 正文行 / tool mono 行。 */
  readonly kind: 'assistant' | 'tool'
}

/** 统一时间线的 Step 卡片项。 */
export interface TimelineStepItem {
  readonly kind: 'step'
  readonly stepId: string
  readonly name: string
  readonly status: StepStatus
  /** 循环迭代标签（如 `#1.2`）。 */
  readonly loopLabel?: string | undefined
  /** 段开始时间（ISO，createdAt 优先回退 updatedAt/startedAt；旧实例可能缺）。 */
  readonly time?: string | undefined
  /** completed 态输出文本（text 块拼接）。 */
  readonly outputText?: string | undefined
  /** failed 态错误详情。 */
  readonly error?: string | undefined
  /** 收尾阶段（finalizeMeta.currentPhase：assess/ask/finalize/gate/completed；供状态按钮徽标）。 */
  readonly finalizePhase?: string | undefined
  /** 收尾错误详情（finalizeMeta.errorDetail，如门禁失败原因；failed 态附加展示）。 */
  readonly finalizeErrorDetail?: string | undefined
  /** 子代理会话 id（跳「查看详情」）。 */
  readonly childId?: string | undefined
  /** 是否合成会话（shell 无真实子代理，标题不可点击跳子代理页）。 */
  readonly synthetic?: boolean | undefined
  /** sessionMessages 展示行（内嵌消息框 / 失败·暂停最近 N 条）。 */
  readonly messages?: readonly ChatLine[] | undefined
  readonly visitCount: number
  /** 执行段序号（同 stepId 第几次执行段；0-based，缺省 0 = 首次执行）。 */
  readonly attemptIndex?: number | undefined
  /** 暂停定格时间（paused 段展示暂停提示时用）。 */
  readonly pausedAt?: string | undefined
}

/** 统一时间线的用户气泡项。 */
export interface TimelineUserItem {
  readonly kind: 'user'
  readonly content: string
  /** 消息时间（ISO，createdAt）。 */
  readonly time: string
  /** 消息种类（input/resume/retry/answer；旧实例可能缺，回退 input 语义）。 */
  readonly messageKind?: string | undefined
  /** 目标：'broadcast' 或 Step 定义 id（定点）；input 时为 ''。 */
  readonly target?: string | undefined
}

/** 统一时间线条目（Step 卡片 / 用户气泡，按时间顺序）。 */
export type TimelineItem = TimelineStepItem | TimelineUserItem

/** 相对时间展示结果（由组件用字典文案渲染）。 */
export type RelativeTime =
  | { readonly kind: 'justNow' }
  | { readonly kind: 'minutes'; readonly count: number }
  | { readonly kind: 'hours'; readonly count: number }
  | { readonly kind: 'days'; readonly count: number }
  | { readonly kind: 'date'; readonly text: string }

/**
 * 计算相对时间（ISO → 刚刚 / N 分钟前 / N 小时前 / N 天前；跨 7 天回退短日期）。
 * @param iso - 目标时间（ISO 串），undefined 返回 undefined。
 * @param nowIso - 基准「现在」（ISO 串）。
 * @returns 相对时间结果或 undefined。
 */
export function relativeTimeOf(iso: string | undefined, nowIso: string): RelativeTime | undefined {
  if (iso === undefined) return undefined
  const then = Date.parse(iso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(then) || Number.isNaN(now)) return undefined
  const diffMs = now - then
  if (diffMs < 60_000) return { kind: 'justNow' }
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return { kind: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { kind: 'hours', count: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { kind: 'days', count: days }
  const date = new Date(then)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    kind: 'date',
    text: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

/** 把任意载荷值缩略为单行文本（供 tool 消息行展示）。 */
function summarizeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return undefined
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * 把 step 的 sessionMessages 派生为展示行（agent 内嵌消息框 / 失败列表用）。
 * tool 消息 → `┌ tool\n└ 输出摘要`（mono 行）；text/reasoning → 正文行。
 * @param step - 已执行 Step 快照。
 * @returns 展示行列表；无消息返回 undefined。
 */
export function chatLinesOf(step: ExecutedStep): ChatLine[] | undefined {
  const messages = step.sessionMessages
  if (messages === undefined || messages.length === 0) return undefined
  const lines: ChatLine[] = []
  for (const message of messages) {
    if (message.type === 'tool') {
      const head = `┌ ${message.tool ?? 'tool'}`
      const output = summarizeValue(message.output)
      lines.push({
        who: `${step.name} · tool`,
        text: output === undefined ? head : `${head}\n└ ${output}`,
        kind: 'tool',
      })
    } else {
      const text = message.text
      if (text === undefined || text === '') continue
      lines.push({ who: `${step.name} · agent`, text, kind: 'assistant' })
    }
  }
  return lines.length === 0 ? undefined : lines
}

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
    // 段模型下同 stepId 多次执行段（暂停续跑/重试/ask 续问）在树导航里聚合成一个
    // step 节点：取 attemptIndex 最大（最后）的一段展示状态，避免重复展开。
    const steps = state.executedSteps
      .filter(step => step.stageId === stage.id)
      .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))
    const seen = new Set<string>()
    const uniqueSteps = steps.filter(step => {
      const key = stepIdOf(step)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return {
      id: stage.id,
      name: stage.name,
      type: 'stage' as const,
      status: stage.status,
      children: uniqueSteps.map(step => {
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
    name: state.workflowName ?? state.workflowId,
    type: 'workflow' as const,
    status: state.status,
    children: stageNodes,
  }]
}

/**
 * 段模型下按「最后活跃段」聚合 Step 列表（DiscussionInput @Step 定点恢复用）。
 *
 * 同 stepId 多次执行段（暂停续跑/重试/ask 续问）只保留 attemptIndex 最大的段，
 * 避免 @Step 选择器重复展示同一 Step 的多个执行段。
 * @param steps - 实例的 executedSteps（可能含同 stepId 多段）。
 * @returns 按 stepId 去重后的 Step 快照列表（取最后活跃段；非子代理 Step 原样保留）。
 */
export function lastActiveSegmentsOf(steps: readonly ExecutedStep[]): ExecutedStep[] {
  const byStepId = new Map<string, ExecutedStep>()
  for (const step of steps) {
    const key = stepIdOf(step)
    const current = byStepId.get(key)
    if (current === undefined || (step.attemptIndex ?? 0) >= (current.attemptIndex ?? 0)) {
      byStepId.set(key, step)
    }
  }
  return [...byStepId.values()]
}

/**
 * 从 `WorkflowTaskState` 构建统一时间线（段模型 + 用户消息统一排序）。
 *
 * 三路来源严格按 `createdAt` 排序合并：
 * 1. `userMessages`（input/resume/retry/answer，含原始需求——初始 input 消息
 *    由引擎 makeInitialState 写入，前端不再单独拼 `state.originalInput` 气泡）
 * 2. executedSteps 各**执行段**（`createdAt` 为段开始时间；同 stepId 多次执行段
 *    各自成卡，`attemptIndex` 标注第几次）
 * 3. running 卡无实时消息流（引擎不写 sessionMessages、无 step-message 事件），
 *    body 按状态展示输出文本 / 错误 / 运行中占位。
 * @param state - 实例状态快照。
 * @returns 时间线条目列表（按 createdAt 升序）。
 */
export function buildTimeline(state: WorkflowTaskState): TimelineItem[] {
  const items: TimelineItem[] = []

  for (const message of state.userMessages ?? []) {
    items.push({
      kind: 'user',
      content: message.content,
      time: message.createdAt,
      messageKind: message.kind,
      target: message.target,
    })
  }

  for (const step of state.executedSteps) {
    items.push({
      kind: 'step',
      stepId: stepIdOf(step),
      name: step.name,
      status: step.status,
      loopLabel: loopLabelOf(step.loopIteration),
      time: step.createdAt ?? step.updatedAt ?? step.startedAt,
      outputText: outputTextOf(step.output),
      error: step.error,
      finalizePhase: step.finalizeMeta?.currentPhase,
      finalizeErrorDetail: step.finalizeMeta?.errorDetail,
      childId: step.sessionMeta?.childId,
      synthetic: step.sessionMeta?.synthetic,
      messages: chatLinesOf(step),
      visitCount: step.visitCount,
      attemptIndex: step.attemptIndex,
      pausedAt: step.pausedAt,
    })
  }

  // 统一时间轴：严格按 createdAt 排序（旧实例缺 createdAt 的段排最后）。
  items.sort((a, b) => {
    const ta = a.time === undefined ? '' : a.time
    const tb = b.time === undefined ? '' : b.time
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
  return items
}
