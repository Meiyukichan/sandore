/**
 * orchestration-tool-model.ts：`sandore_workflow_run` / `sandore_workflow_control` 三个
 * 工具调用行里内嵌「工作流导航」UI 所需的**纯逻辑**（零 React、零 RPC，可直接单测）。
 *
 * ## 用户需求（原话）
 * > 「dsh 默认的 workflow 工具，调用起来后会有一个 UI，一种类似于目录树的 UI……我希望
 * >  run / 暂停和 continue 工作流这三个工具，除了现在默认的返回外，还要有 UI，就直接用
 * >  工作流导航的，风格和 dsh 默认的 workflow 一致」
 *
 * ## 数据从哪来（不新增任何 RPC / typert 产物）
 * 工具行的本地 block（`step-row-data.ts` 的 {@link StepToolCallBlock}）里已经带了
 * **调用参数**（`argsRaw`）与**结果内容**（`content` 文本块），而工具本身的返回面带着
 * `instanceId`：
 * - `sandore_workflow_run` → `{ ok:true, action, data:{ instanceId, status:'running' } }`
 *   （`packages/workflow/run-tool.ts:75/151`）；实例是**这次调用新建**的，所以
 *   instanceId 只能从**结果**里读；
 * - `sandore_workflow_control` → 入参 `{ action:'pause'|'continue', scope?, message?,
 *   instanceId? }`（`packages/workflow/control-tool.ts:37-81`）：`instanceId` 可省略，
 *   省略时引擎按「调用会话 = 宿主会话 = instanceId」反查（架构决策 1 的恒等式）——
 *   工具行所在面板的会话 id 就是那个宿主会话，故用面板 sessionId 兜底。
 *
 * 于是「这个工具行该不该渲染导航 UI、渲染哪个实例」完全是块内数据的纯函数，实时状态
 * 由 {@link ./orchestration-tool-store.ts} 按 instanceId 拉取/订阅。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-model
 */
import { buildRunTree, type RunTreeNode } from './run-view-model.ts'
import type { StepToolCallBlock } from './step-view/step-row-data.ts'

/** 启动工作流的工具名（wire name；工具行 keyed 视图按它分发）。 */
export const ORCHESTRATION_RUN_TOOL = 'sandore_workflow_run'

/** 暂停/继续工作流的工具名（wire name）。 */
export const ORCHESTRATION_CONTROL_TOOL = 'sandore_workflow_control'

/** 需要内嵌导航 UI 的工具名集合（其余工具一律不渲染——注册条件即此表）。 */
export const ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  ORCHESTRATION_RUN_TOOL,
  ORCHESTRATION_CONTROL_TOOL,
]

/** control 工具的动作（`packages/workflow/control-tool.ts:78`）。 */
export type OrchestrationControlAction = 'pause' | 'continue'

/** 一个工具行解析出的导航目标（`undefined` = 不是我们的工具 → 不渲染导航）。 */
export interface OrchestrationToolTarget {
  /** wire 工具名（run / control）。 */
  readonly toolName: string
  /** 目标实例 id（宿主会话 id）。 */
  readonly instanceId: string
  /** control 的动作；run 行或缺省 → undefined。 */
  readonly action?: OrchestrationControlAction | undefined
  /**
   * instanceId 的来源：`'result'`（结果里读到的，最可靠）｜`'args'`（调用参数显式传了）｜
   * `'session'`（面板会话兜底 = 恒等式反查）。取证/断言用。
   */
  readonly instanceIdSource: 'result' | 'args' | 'session'
}

/** 从任一生命周期形式解析 wire 名（与 `ToolCallView.stepToolCallName` 同义，避免反向依赖）。 */
export function orchestrationToolNameOf(block: StepToolCallBlock): string {
  return 'kind' in block ? block.call?.name ?? '' : block.name
}

/** 在任意 JSON 形状里递归找一个字符串字段（深度/规模有界；损坏数据不爆栈）。 */
function findStringField(raw: unknown, field: string, depth = 0): string | undefined {
  if (depth > 8 || raw === null || typeof raw !== 'object') return undefined
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findStringField(item, field, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = raw as Record<string, unknown>
  const direct = record[field]
  if (typeof direct === 'string' && direct !== '') return direct
  for (const value of Object.values(record)) {
    const found = findStringField(value, field, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** 解析一段可能是 JSON、也可能把 JSON 包在文本里的字符串（工具结果文本形态）。 */
function parseLoose(raw: string): unknown {
  const text = raw.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    // 文本里嵌了 JSON（例如 `已完成：{"instanceId":"…"}`）：取第一个 { 到最后一个 } 再试。
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/** 结算结果的文本块拼接（`content` 是 loose 块数组；只取 text 叶子）。 */
function resultTextOf(block: StepToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  for (const item of block.content) {
    if (item === null || typeof item !== 'object') continue
    const text = (item as { readonly text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** 解析一次工具调用的参数（`argsRaw` 是 JSON 字符串；坏 JSON → undefined）。 */
function argsOf(block: StepToolCallBlock): Record<string, unknown> | undefined {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const parsed = parseLoose(raw)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/** control 动作（参数优先，其次结果回显；非法 → undefined）。 */
function actionOf(block: StepToolCallBlock): OrchestrationControlAction | undefined {
  const fromArgs = argsOf(block)?.['action']
  if (fromArgs === 'pause' || fromArgs === 'continue') return fromArgs
  const fromResult = findStringField(parseLoose(resultTextOf(block)), 'action')
  if (fromResult === 'pause' || fromResult === 'continue') return fromResult
  return undefined
}

/**
 * 解析一个工具行是否属于「需要内嵌导航 UI」的三个工具，以及目标实例。
 *
 * instanceId 读取优先级：**结果**（run 新建实例的唯一来源）→ **调用参数**（control 显式传）
 * → **面板会话 id 兜底**（恒等式：调用会话 ≡ instanceId）。
 * @param root - 工具行的 root block（`StepChatToolCallPayload.root`）。
 * @param fallbackInstanceId - 面板所在会话 id（宿主会话 = 实例 id；缺省 `''` 表示不可兜底）。
 * @returns 目标（含来源标注），或 undefined（不是我们的工具 / 拿不到实例 id）。
 */
export function orchestrationToolTargetOf(
  root: StepToolCallBlock | undefined,
  fallbackInstanceId = '',
): OrchestrationToolTarget | undefined {
  if (root === undefined) return undefined
  const toolName = orchestrationToolNameOf(root)
  if (!ORCHESTRATION_TOOL_NAMES.includes(toolName)) return undefined

  const fromResult = findStringField(parseLoose(resultTextOf(root)), 'instanceId')
  if (fromResult !== undefined) {
    return {
      toolName,
      instanceId: fromResult,
      ...(actionOf(root) === undefined ? {} : { action: actionOf(root) }),
      instanceIdSource: 'result',
    }
  }
  const explicit = argsOf(root)?.['instanceId']
  if (typeof explicit === 'string' && explicit !== '') {
    return {
      toolName,
      instanceId: explicit,
      ...(actionOf(root) === undefined ? {} : { action: actionOf(root) }),
      instanceIdSource: 'args',
    }
  }
  if (fallbackInstanceId === '') return undefined
  return {
    toolName,
    instanceId: fallbackInstanceId,
    ...(actionOf(root) === undefined ? {} : { action: actionOf(root) }),
    instanceIdSource: 'session',
  }
}

/** 导航 UI 的展示模型（树 + 进度计数；由实例状态快照派生）。 */
export interface OrchestrationNavModel {
  /** 实例状态（引擎 7 态原文；未知 → `''`）。 */
  readonly status: string
  /** 工作流名（状态里带 → 显示；缺省空串）。 */
  readonly workflowName: string
  /** 阶段-步骤树（复用 `buildRunTree`：与运行页左栏导航同一份派生）。 */
  readonly tree: readonly RunTreeNode[]
  /** Step 节点总数 / 已完成数（进度计数；用于「3/5」这类读数）。 */
  readonly stepTotal: number
  readonly stepDone: number
}

/** 结构读：状态快照里可能的字符串字段（不依赖 workflow 的 zod 类型）。 */
interface StateLike {
  readonly status?: unknown
  readonly workflowName?: unknown
  readonly workflowId?: unknown
}

/** 遍历树统计 step 节点（含嵌套；只读 name/status/children）。 */
function countSteps(nodes: readonly RunTreeNode[]): { total: number; done: number } {
  let total = 0
  let done = 0
  const walk = (list: readonly RunTreeNode[]): void => {
    for (const node of list) {
      if (node.type === 'step') {
        total += 1
        if (node.status === 'completed') done += 1
      }
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return { total, done }
}

/**
 * 由实例状态快照派生导航展示模型（纯函数）。
 *
 * 树直接复用 `buildRunTree(state)`——与运行页左栏的「工作流导航」**同一份派生**，
 * 不另写一套树（用户要求「直接用工作流导航的」）。
 * @param state - `getInstanceState` 返回的 `WorkflowTaskState`（未知形状按空态处理）。
 * @returns 展示模型。
 */
export function orchestrationNavOf(state: unknown): OrchestrationNavModel {
  const record = (state ?? {}) as StateLike & { readonly executedSteps?: unknown; readonly stageContracts?: unknown }
  // 形状守门：`buildRunTree` 需要 `executedSteps` + `stageContracts`（缺一即抛）。工具行可能
  // 在实例刚创建时拿到半成品快照，这里对**不可用形状**直接给空树（不抛、由卡片显示空态）。
  const usable = Array.isArray(record.executedSteps)
    && typeof record.stageContracts === 'object' && record.stageContracts !== null
  const tree = usable ? buildRunTree(state as Parameters<typeof buildRunTree>[0]) : []
  const counts = countSteps(tree)
  const name = typeof record.workflowName === 'string'
    ? record.workflowName
    : typeof record.workflowId === 'string' ? record.workflowId : ''
  return {
    status: typeof record.status === 'string' ? record.status : '',
    workflowName: name,
    tree,
    stepTotal: counts.total,
    stepDone: counts.done,
  }
}

/**
 * 展示等价签名（快照引用稳定化用）。
 *
 * `useSyncExternalStore` 要求「无变化时返回同一引用」，否则每次发布都重渲。树的派生成
 * 本低但对象每轮都新，故用签名做浅层等价判定：签名相同 → 复用上一份模型对象。
 * @param model - 本次派生结果。
 * @returns 等价签名（状态 + 每个节点的 id/状态/名称）。
 */
export function orchestrationNavSignature(model: OrchestrationNavModel): string {
  const parts: string[] = [model.status, model.workflowName, String(model.stepTotal), String(model.stepDone)]
  const walk = (nodes: readonly RunTreeNode[]): void => {
    for (const node of nodes) {
      parts.push(`${node.type}:${node.id}:${String(node.status ?? '')}:${node.name}`)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(model.tree)
  return parts.join('|')
}
