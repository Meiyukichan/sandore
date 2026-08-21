/**
 * 主会话 composer 问答卡的聚合数据源（BUG 1 修复，方案 A）。
 *
 * 根因：sandore 引擎的 ask 以 `hostAgent`（id === instanceId）调用
 * `ctx.userQuestions.ask`，DSH 把 question/requested 帧路由到 instanceId 会话；
 * 主会话无 PendingWait，DSH 原生 composer 只认当前会话 pending，故主会话不渲染
 * 选择框。本模块轮询全部非终态实例的 `getInstanceState`，聚合其
 * `pendingInteractions` 中的 pending question，供 `conversation.composer` 的
 * sandore 条目（SandoreQuestionComposer）读取，绕过 DSH 帧路由的会话归属限制。
 *
 * 与 `workflow-store.ts` 相同的 getSnapshot/subscribe 自实现模式（DSH bundle 的
 * ModuleLoader 格式无法被 bundler 静态分析出 `createSnapshotStore` 具名导出）。
 * 轮询间隔 3s（防 RPC 过频）；失败静默（catch 后下一轮继续，不抛）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-questions
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InstanceSummary } from '@deepseek-ai/dsh-sandore-workflow/remote'
import type { PendingQuestionEntry, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/schema'

import { unwrap } from './remote.ts'
import { partitionInteractions } from './run-view-model.ts'

/** 轮询间隔（毫秒）：3s 平衡及时性与 RPC 频率。 */
const POLL_INTERVAL_MS = 3000

/** 非终态实例状态（需轮询其 pending 交互；终态无待办，跳过省 RPC）。 */
const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'interacting', 'paused'])

/** 聚合轮询所需的 `ctx.remote.sandore` 最小访问面（返回 `RemoteResult`，经 `unwrap` 解包）。 */
export interface SandoreQuestionsRemote {
  listInstances(): Promise<RemoteResult<InstanceSummary[]>>
  getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>
}

/** 一条待答 sandore 问题（聚合视图：实例 + 工作流 + 原始 pending 条目）。 */
export interface SandorePendingQuestion {
  readonly instanceId: string
  /** 实例归属的工作流 id（workflowName 缺省时回落；供多实例标注 `[workflowName]`）。 */
  readonly workflowName: string
  readonly entry: PendingQuestionEntry
}

let questions: readonly SandorePendingQuestion[] = []
const listeners = new Set<() => void>()

/** 当前聚合快照（稳定引用，仅内容变更时更换）。 */
export function getSandoreQuestions(): readonly SandorePendingQuestion[] {
  return questions
}

/** 订阅聚合快照变更。 */
export function subscribeSandoreQuestions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 内容签名：任一 (instanceId, requestId) 变化即通知订阅者（稳定引用防无谓重渲染）。 */
function signatureOf(list: readonly SandorePendingQuestion[]): string {
  return list.map(item => `${item.instanceId}:${item.entry.requestId}`).join('|')
}

let lastSignature = ''

/** 仅内容变化时替换快照并通知订阅者（空转轮询不触发重渲染）。 */
function setQuestions(next: readonly SandorePendingQuestion[]): void {
  const signature = signatureOf(next)
  if (signature === lastSignature) return
  lastSignature = signature
  questions = next
  for (const listener of listeners) listener()
}

// ── 本地变更（乐观移除）与轮询的竞态护栏 ────────────────────────────────────
//
// 回答成功后本地立即移除该问题（不等待下一轮轮询，卡片即时消失/轮换）。
// 轮询取到的快照可能早于该本地变更（fetch 发起时引擎尚未落库），若照单全收会
// 把已答问题重新写回 store（卡片闪回）。故每次 refresh 开始时记录 mutationSeq，
// 返回时若发现期间发生过本地变更则丢弃本轮结果，由下一轮轮询以新快照校正。

let mutationSeq = 0

/**
 * 本地移除一条已答/已拒问题（回答成功后的乐观移除；引擎侧同一请求重复答复会被拒绝）。
 * @param instanceId - 实例 id。
 * @param requestId - 交互条目 requestId。
 */
export function removeSandoreQuestion(instanceId: string, requestId: string): void {
  mutationSeq += 1
  setQuestions(questions.filter(item =>
    !(item.instanceId === instanceId && item.entry.requestId === requestId),
  ))
}

/** 拉取一轮：listInstances → 非终态 → getInstanceState → partitionInteractions 过滤 pending question。 */
async function refreshQuestions(remote: SandoreQuestionsRemote): Promise<void> {
  const mutationAtStart = mutationSeq
  try {
    const instances = unwrap(await remote.listInstances())
    const next: SandorePendingQuestion[] = []
    for (const instance of instances) {
      if (!NON_TERMINAL_STATUSES.has(instance.status)) continue
      // RunViewRemote 最小接口把 getInstanceState 标为 unknown，Host 实际返回 WorkflowTaskState。
      const state = unwrap(await remote.getInstanceState(instance.instanceId)) as WorkflowTaskState
      const { questions: pending } = partitionInteractions(state.pendingInteractions)
      for (const entry of pending) {
        next.push({
          instanceId: instance.instanceId,
          workflowName: state.workflowName ?? state.workflowId,
          entry,
        })
      }
    }
    if (mutationSeq !== mutationAtStart) return // 轮询期间发生本地变更，丢弃本轮结果
    setQuestions(next)
  } catch {
    // 失败静默：单实例/单次轮询失败不打断循环，下一轮继续。
  }
}

/**
 * 启动聚合轮询并返回 disposer（递归 setTimeout + disposed 标志模式，照 RunView）。
 * @param remote - 聚合轮询所需的 sandore RPC 访问面。
 * @returns 停止轮询的 disposer（经调用方 `ctx.effect` 绑定插件 fiber）。
 */
export function startSandoreQuestionsPolling(remote: SandoreQuestionsRemote): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async (): Promise<void> => {
    await refreshQuestions(remote)
    if (disposed) return
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        void poll()
      }, POLL_INTERVAL_MS)
    }
  }

  void poll()

  return () => {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}
