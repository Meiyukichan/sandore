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
  /** 循环迭代标签（如 `#1.2`），非循环 Step 缺省。 */
  readonly loopLabel?: string
  /** completed 态的内联结果文本块（缺省表示无文本输出）。 */
  readonly output?: readonly SandoreTextBlock[]
  /** failed 态的错误详情。 */
  readonly error?: string
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
  readonly loopIteration?: readonly number[]
  readonly output?: readonly SandoreTextBlock[]
  readonly error?: string
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
        return { ...context.state, status: 'completed', output }
      }
      case 'sandore/step-failed':
        return { ...context.state, status: 'failed', error: match.event.data.error }
      case 'sandore/step-paused':
        return { ...context.state, status: 'paused' }
      case 'sandore/step-resumed':
      case 'sandore/step-retried':
        return { ...context.state, status: 'running' }
      /* v8 ignore next -- update 仅对 match 命中的 5 个 step-* 事件派发。 */
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
        ...(state.output === undefined ? {} : { output: state.output }),
        ...(state.error === undefined ? {} : { error: state.error }),
      },
    }
  },
}
