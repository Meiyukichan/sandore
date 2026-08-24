/**
 * sandore-step 讨论节点定义：把 6 个 sandore/step-* Session 事件折叠为单个
 * keyed Chat 节点（kind `sandore-step`、target `chat`）。
 *
 * `match` 命中 `sandore/step-start|step-completed|step-failed|step-paused|
 * step-resumed|step-retried`；`start`/`update` 折叠为节点状态
 * `{stepId, childId, name, status, loopIteration?, output?, error?}`。同一
 * `stepId` 的循环多次迭代以 `stepId#loopIteration` 派生独立节点 id。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-step-definition
 */
import type {
  ChatConversationViewNode, ConversationNodeDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
// 引入 seam.ts 的 SessionEventMap 声明合并（`sandore/*` 事件词表），使
// `match` 内对 `event.type`/`event.data` 的判别收窄获得类型。
import type {} from '@deepseek-ai/dsh-sandore-workflow/src/seam'

/** 单个 sandore-step 节点的折叠状态（running/completed/failed/paused 四态）。 */
export type SandoreStepStatus = 'running' | 'completed' | 'failed' | 'paused'

/** step-completed output 中内联渲染所需的纯文本块。 */
export interface SandoreTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** keyed Chat 渲染器的 payload（经 buildViewNode 投影）。 */
export interface SandoreStepChatData {
  readonly stepId: string
  readonly childId: SessionId
  readonly name: string
  readonly status: SandoreStepStatus
  /** childId 是否为合成占位（shell 无真实子会话，不可跳转；与 run-view-model 同语义）。 */
  readonly synthetic?: boolean
  /** 循环迭代标签（如 `#1.2`），非循环 Step 缺省。 */
  readonly loopLabel?: string
  /** completed 态的内联结果文本块（缺省表示无文本输出）。 */
  readonly output?: readonly SandoreTextBlock[]
  /** failed 态的错误详情。 */
  readonly error?: string
  // Round 9：收尾阶段信息（供 DagStepNodeView 渲染可点击 badge）
  /** 当前收尾阶段（ask-detect/finalizing/gating/routing/completed）。 */
  readonly finalizePhase?: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 单个 Step 的讨论节点 payload。 */
    'sandore-step': SandoreStepChatData
  }
}

/** 折叠状态（与 step-* 事件 payload 对齐，output 收窄为纯文本块）。 */
interface SandoreStepState {
  readonly stepId: string
  readonly childId: SessionId
  readonly name: string
  readonly status: SandoreStepStatus
  /** childId 是否为合成占位（step-start 载荷为合成占位；update 收到真实会话 id 时置 false）。 */
  readonly synthetic?: boolean
  readonly loopIteration?: readonly number[]
  readonly output?: readonly SandoreTextBlock[]
  readonly error?: string
  // Round 9：收尾阶段字段（由 sandore/step-phase 事件累计）
  readonly finalizePhase?: string
}

/** 由 stepId + 循环迭代路径派生稳定节点 id（`step-xxx` 或 `step-xxx#1.2`）。 */
export function nodeIdOf(stepId: string, loopIteration: readonly number[] | undefined): string {
  return loopIteration === undefined || loopIteration.length === 0
    ? stepId
    : `${stepId}#${loopIteration.join('.')}`
}

/** 循环迭代路径 → 展示标签（`#1.2`），非循环返回 undefined。 */
export function loopLabelOf(loopIteration: readonly number[] | undefined): string | undefined {
  return loopIteration === undefined || loopIteration.length === 0
    ? undefined
    : `#${loopIteration.join('.')}`
}

/**
 * 用 update 事件载荷的 childId 覆盖折叠状态，并按「childId 是否变化」推断 synthetic：
 * 载荷与 start 的合成占位相同（shell 无真实子会话，stage-executor 回退同一
 * 占位）→ 保持原 synthetic（true，不可跳转）；载荷换成真实会话 id
 * （prompt/agent/skill/mcp 的 sessionMeta.childId）→ synthetic: false（可跳转）。
 */
function realChildIdOf(
  state: { readonly childId: SessionId; readonly synthetic?: boolean },
  childId: string,
): Pick<SandoreStepState, 'childId' | 'synthetic'> {
  // start 起 synthetic 恒有值；此处对 undefined 用省略式规避 exactOptionalPropertyTypes。
  const synthetic = childId === state.childId ? state.synthetic : false
  return {
    childId: childId as SessionId,
    ...(synthetic === undefined ? {} : { synthetic }),
  }
}

/** 单个 Step 的讨论节点状态机（sandore 6 个 step-* 事件折叠）。 */
export const sandoreStepDefinition: ConversationNodeDefinition<SandoreStepState> = {
  kind: 'sandore-step',
  target: 'chat',
  match: (event) => {
    if (event.type === 'sandore/step-start') {
      return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'start' }
    }
    if (event.type === 'sandore/step-completed'
      || event.type === 'sandore/step-failed'
      || event.type === 'sandore/step-paused'
      || event.type === 'sandore/step-resumed'
      || event.type === 'sandore/step-retried') {
      return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' }
    }
    // Round 9：匹配 step-phase 事件，更新阶段数据到同一个 step 节点。
    // stepPhaseDefinition（kind sandore-step-phase）独立 match 同一事件不冲突
    // （conversation assembler 允许多个 definition 独立 match，不同 kind 产生独立 context）。
    if (event.type === 'sandore/step-phase') {
      return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'sandore/step-start') {
      throw new Error('sandore-step start requires sandore/step-start')
    }
    const { stepId, childId, name, loopIteration } = match.event.data
    return {
      stepId,
      // brand 仅编译期标记，运行时就是同一字符串。
      childId: childId as SessionId,
      name,
      status: 'running',
      // step-start 载荷 childId 是合成占位（stage-executor synthesizeChildId）；真实会话
      // id 由后续 update 事件覆盖，同时把 synthetic 置 false。
      synthetic: true,
      ...(loopIteration === undefined ? {} : { loopIteration }),
    }
  },
  update: (context, match) => {
    switch (match.event.type) {
      case 'sandore/step-completed': {
        const output: SandoreTextBlock[] = []
        for (const block of match.event.data.output) {
          if (block.type === 'text') output.push({ type: 'text', text: block.text })
        }
        return { ...context.state, status: 'completed', output, ...realChildIdOf(context.state, match.event.data.childId) }
      }
      case 'sandore/step-failed':
        return {
          ...context.state,
          status: 'failed',
          error: match.event.data.error,
          ...realChildIdOf(context.state, match.event.data.childId),
        }
      case 'sandore/step-paused':
        return { ...context.state, status: 'paused', ...realChildIdOf(context.state, match.event.data.childId) }
      case 'sandore/step-resumed':
        return {
          ...context.state,
          status: 'running',
          ...realChildIdOf(context.state, match.event.data.childId),
        }
      case 'sandore/step-retried':
        // step-retried 载荷不含 childId（seam.ts），仅回到 running，保留原 childId/synthetic。
        return { ...context.state, status: 'running' }
      // Round 9：step-phase 事件——累计阶段数据到节点状态。
      case 'sandore/step-phase': {
        const data = match.event.data
        return {
          ...context.state,
          finalizePhase: data.phase,
        }
      }
      /* v8 ignore next -- update 仅对 match 命中的事件派发。 */
      default:
        return context.state
    }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    const state = context.state
    return {
      key: context.key,
      kind: 'sandore-step',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        stepId: state.stepId,
        childId: state.childId,
        name: state.name,
        status: state.status,
        ...(state.loopIteration === undefined ? {} : { loopLabel: loopLabelOf(state.loopIteration) }),
        ...(state.synthetic === undefined ? {} : { synthetic: state.synthetic }),
        ...(state.output === undefined ? {} : { output: state.output }),
        ...(state.error === undefined ? {} : { error: state.error }),
        // Round 9：finalize 字段投影
        ...(state.finalizePhase === undefined ? {} : { finalizePhase: state.finalizePhase }),
      },
    }
  },
}
