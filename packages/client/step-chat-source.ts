/**
 * StepChatPanel 的「子代理会话对话数据源」适配层。
 *
 * 当前部署走 rc.1 风格（dsh-api-session-controller@0.1.2-rc.1 客户端）：
 * `SessionSnapshot` 只含生命周期字段（openState/running/...），对话数据由 app 级
 * `uiConversation.binding(binding).target('chat')`（ChatView target，`ChatSnapshot`）
 * 产出（order/nodes/processSource/navigation/timeline）。
 *
 * 本模块提供 view-node 读取面：`createStepChatViewSource(binding)` 直接消费
 * rc.1 ChatSnapshot 的 order/nodes/processSource/navigation/timeline（本地契约见
 * chat-view-contract.ts），供 StepChatBody 的「面板内滚动 + 逐 key 行骨架」渲染；
 * 订阅粒度对齐 ChatView：target 外层 subscribe 覆盖全部发布（含流式，按 rAF 合并），
 * 行级 ChatNodeStore.source(key) 的 per-key 订阅面经 `nodeSource(key)` 透出
 * （行组件用）。resolveChatTarget 探测可用 target，缺失时返回 undefined → 面板空态。
 *
 * 注：跨包类型一律结构探测 + cast——sandore 客户端不（也不应）静态依赖
 * ui-conversation/ui-chat 的实现类型，只消费运行期服务形状。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-source
 */
import {
  STEP_CHAT_EMPTY_ORDER,
  isStepChatSnapshotLike,
  stepChatViewNodeOf,
  type StepChatObservableSourceLike,
  type StepChatSnapshotLike,
  type StepChatViewFeed,
  type StepChatViewNode,
  type StepChatViewRead,
} from './chat-view-contract.ts'

// ── subagent-kind 传输地址（2026-09-09 真实 probe 实证：rc.1 宿主对 plain open 的
//   子代理会话恒返 session/agent-busy，运行中与 settle 后都拒；唯一可行通道是
//   {kind:'subagent', parentSessionId, childSessionId, mode}）──────────────────────────
//
// **mode 必须与宿主目录（catalog）里该子代理条目的 mode 一致**（2026-09-13 真机实证）：
// - `manager.selectSubagent`（session-controller client）判据是
//   `catalog.entries.find(e => e.id === child && e.kind === 'child' && e.mode === address.mode)`
//   （`.../client/sessions/manager.ts:191-196`），不一致就抛
//   `sessions.selectSubagent: <childId> is not a healthy catalog child`；
// - 条目 mode 的来源是**子代理身份投影**（`subagent/descriptor` 的 `mode`）：
//   `identity.mode === 'one-shot' ? 'one-shot' : 'continuable'`
//   （`@deepseek-ai/dsh-subagent` 的 `list-children.ts:363-386`）。
// 于是两条 lane 的 mode 天生不同：
// - **门禁**子代理由 `subagents.startContinuable` 建（DSH provider 写 descriptor）→ `continuable`；
// - **收尾 fork / 路由 fork / 重试 fork** 由引擎裸 `agents.create` 建，身份事件由
//   `workflow/subagent-identity.ts` 补写且 `mode: 'one-shot'` → 目录条目 `one-shot`。
// 只认 `continuable` 会让后两条 lane 恒被拒（真机现象：点「收尾中 / 判断中」→ 打开通道被拒
// → 回落普通 open → `历史加载失败`）。故本模块按「两种 mode 依次尝试」打开。

/** 目录条目的两种子代理 mode（`@deepseek-ai/dsh-subagent` 的 `SubagentAddress.mode`）。 */
export type StepChatSubagentMode = 'continuable' | 'one-shot'

/** subagent-kind 传输地址形状。 */
export interface StepChatSubagentAddress {
  readonly kind: 'subagent'
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: StepChatSubagentMode
}

/** 会话实例的 configureSubagent 探测面（两代运行时 Session 对象上均有此方法）。 */
export interface StepChatTransportSession {
  configureSubagent?(address: StepChatSubagentAddress | undefined, parentAvailable?: boolean): void
}

/**
 * 组 subagent-kind 地址；parent 未知/空串返回 undefined（调用方此时不得 plain open）。
 * @param mode - 目录条目 mode（缺省 `continuable`；引擎自建 fork 是 `one-shot`）。
 */
export function buildStepChatAddress(
  parent: string | undefined,
  child: string,
  mode: StepChatSubagentMode = 'continuable',
): StepChatSubagentAddress | undefined {
  if (parent === undefined || parent === '') return undefined
  return { kind: 'subagent', parentSessionId: parent, childSessionId: child, mode }
}

/**
 * 取某子代理目录条目的真实 mode；**目录冷且宿主支持刷新时才 `await` 一次**。
 *
 * **同步性契约（重要）**：本函数只在「目录快照里没有该条目 **且** 宿主提供 `refreshSubagents`」
 * 时才真的等待——其余情况（含不支持刷新的旧宿主、条目已在快照里）立即返回，于是
 * {@link openStepChatSessionInHost} 在那些情况下**在第一个 `await` 之前就完成了全部副作用**
 * （`openSubagent`/`open` 调用与 transport 装配），调用方（面板点击处理器）的同步断言不受影响。
 *
 * 有界：只刷一次、失败或仍无条目就返回 undefined（调用方退回「两种 mode 依次试 + 最后试过的
 * mode」），不会无限等待。
 * @param sessions - sessions 服务面。
 * @param parent - durable 父（宿主会话 id）。
 * @param child - 目标子会话 id。
 * @returns 目录条目 mode（权威）；读不到 → undefined。
 */
async function resolveCatalogMode(
  sessions: StepChatHostSessionsLike,
  parent: string | undefined,
  child: string,
): Promise<StepChatSubagentMode | undefined> {
  const known = catalogModeOf(sessions, parent, child)
  if (known !== undefined) return known
  const refresh = sessions.refreshSubagents
  if (typeof refresh !== 'function' || parent === undefined || parent === '') return undefined
  try {
    await refresh.call(sessions, parent)
  } catch {
    // 刷新失败（远程错误/父会话不可用）：不猜也不抛，按「未知 mode」继续（下方兜底）。
    return undefined
  }
  return catalogModeOf(sessions, parent, child)
}

/**
 * 从宿主会话列表快照里取某子代理目录条目的真实 mode（`sessions.list` 的
 * `subagentsByParent[parent].entries[]`）。
 *
 * 为什么值得读：DSH 的地址校验要求 `mode` 与目录条目一致（不一致报
 * `subagent mode does not match the supplied address`），而条目 mode 由子代理身份投影决定
 * （provider 建的 = `continuable`；引擎裸 `agents.create` 的 fork = `one-shot`）——
 * 我们**读不到**投影，但列表快照里已经带了现成的 mode。取到即「一次命中」，取不到才退回
 * 「两种 mode 依次试」。
 * @returns 目录条目 mode；快照形状不符 / 父会话无目录 / 无该条目 → undefined。
 */
export function catalogModeOf(
  sessions: StepChatHostSessionsLike,
  parent: string | undefined,
  child: string,
): StepChatSubagentMode | undefined {
  if (parent === undefined || parent === '' || typeof sessions.list?.getSnapshot !== 'function') return undefined
  try {
    const snapshot = sessions.list.getSnapshot() as
      | { readonly subagentsByParent?: Record<string, { readonly entries?: readonly unknown[] } | undefined> }
      | undefined
    const entries = snapshot?.subagentsByParent?.[parent]?.entries
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries) {
      const candidate = entry as { readonly kind?: string; readonly id?: string; readonly mode?: string }
      if (candidate.kind !== 'child' || candidate.id !== child) continue
      return candidate.mode === 'one-shot' ? 'one-shot' : candidate.mode === 'continuable' ? 'continuable' : undefined
    }
  } catch {
    // 快照形状不符/抛错：不猜，交给「两种 mode 依次试」的兜底。
  }
  return undefined
}

/**
 * 两种 mode 的地址候选（**先后顺序 = 尝试顺序**）：`continuable` 优先（provider 建的
 * 可续接子代理 + 门禁 lane），其次 `one-shot`（引擎裸 `agents.create` 的收尾/路由/重试 fork）。
 *
 * 为什么两种都要试：我们**读不到**宿主目录条目（client 侧没有「查条目 mode」的公开面），
 * 而 mode 不匹配必然被 `selectSubagent` 拒；顺序尝试是唯一稳的判据（被拒是纯客户端校验，
 * 无副作用）。
 */
export function buildStepChatAddressCandidates(
  parent: string | undefined,
  child: string,
  /** 目录里已知的真实 mode（{@link catalogModeOf}）：给了就排在最前，一次命中。 */
  known?: StepChatSubagentMode | undefined,
): readonly StepChatSubagentAddress[] {
  const order: readonly StepChatSubagentMode[] = known === undefined
    ? ['continuable', 'one-shot']
    : [known, known === 'continuable' ? 'one-shot' : 'continuable']
  return order
    .map(mode => buildStepChatAddress(parent, child, mode))
    .filter((candidate): candidate is StepChatSubagentAddress => candidate !== undefined)
}

/**
 * 开窗前装配 subagent-kind 传输地址。返回是否已装配（= parent 已知）：
 * - parent 已知 → configureSubagent(subagent 地址) 后返回 true（调用方随即 open()，
 *   走 addressed history → subagents 路由，运行中即可流式）；
 * - parent 未知 → configureSubagent(undefined)（清残留地址）并返回 false（调用方
 *   保持等待，不 plain open——避免无谓的 agent-busy 错误态）。
 */
export function applyStepChatTransport(
  session: unknown,
  parent: string | undefined,
  child: string,
  mode: StepChatSubagentMode = 'continuable',
): boolean {
  const address = buildStepChatAddress(parent, child, mode)
  const transport = session as StepChatTransportSession | undefined
  if (typeof transport?.configureSubagent === 'function') {
    transport.configureSubagent(address, address !== undefined)
  }
  return address !== undefined
}

// ── 「在宿主中心列打开某个子代理会话」的统一入口（打开与历史加载用**同一个**地址） ──────
//
// 真机缺陷（用户报告）：从 step 标题点进子代理会话页，最开头出现
// 「历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）」。
//
// 根因（DSH 源码为证）：
// - `packages/api/session-controller/src/history.ts:273-279` 的 `validateAddress` 对
//   `kind:'session'` 的**普通地址**访问 `origin === 'subagent'` 的会话直接抛 `session/agent-busy`
//   （文案 'subagent Sessions require their durable parent address'）；
// - 会话实例实际用的地址在 `session.ts:763`：`this.address === undefined ? {kind:'session',…}`
//   `: {kind:'subagent', …this.address}` —— 即**地址装配决定历史能不能加载**；
// - 我们的 step 标题入口走的是普通 `sessions.open(childId)`：`manager.select()` 里
//   `navigationAddress()` 解析不到地址就 `configureSubagent(undefined)`（manager.ts:168-179），
//   **把面板先前装配好的 subagent 地址清掉**，于是打开之后的历史请求退回普通地址 → 报错。
//   面板内的会话（StepChatPanel）之所以正常，是因为它在开窗 effect 里自行 `applyStepChatTransport`。
//
// 修法：把「打开」与「transport 装配」收进同一个函数（本函数），两条路径都走它：
// 先按 durable 地址开（`openSubagent` → 普通 open 兜底），**再装配一次 transport 地址**——
// 后者正是「加载更早」用的同一 address，故不会再出现「打开成功、加载历史失败」。
// 地址字面量只在 {@link buildStepChatAddress} 一处组装（单一事实源，不在调用点重写）。

/** {@link openStepChatSessionInHost} 需要的最小 sessions 服务面（结构探测，跨包不引类型）。 */
export interface StepChatHostSessionsLike {
  /** 普通打开（普通会话 / 兜底路径）。 */
  open(id: string): void
  /** 按 durable 父地址打开目录里的健康子会话（缺失则退化到普通 open）。 */
  openSubagent?(address: StepChatSubagentAddress): void
  /** 读取宿主已保留的地址（parent 未知时的兜底）。 */
  subagentAddress?(id: string): StepChatSubagentAddress | undefined
  /** 取会话绑定（用于装配 transport 地址）。 */
  binding?(id: string): StepChatBindingLike | undefined
  /**
   * 刷新某个父会话的**子代理目录**（`session-controller` client 的 `refreshSubagents`）。
   *
   * 为什么需要：目录是懒加载的（`setSubagentCatalogOpen(parent,true)` 只在用户打开子代理
   * 列表时拉取），而 `openSubagent` 要求 child 已在目录里且 mode 匹配；child 刚建出来时
   * 目录可能还没有它。缺省（旧宿主）时该兜底不生效，只记诊断。
   */
  refreshSubagents?(parentSessionId: string): Promise<void>
  /**
   * 会话列表快照（`session-controller` client 的 `sessions.list.getSnapshot()`）。
   *
   * 为什么要读它：快照里的 `subagentsByParent[parent].entries[]` 是**宿主目录的权威副本**
   * （每条 `{ kind:'child', id, mode }`）。有了它就能直接取到该子代理真实的 mode，
   * 不必靠「两种 mode 依次试」猜——真机实证：猜错时宿主以
   * `历史加载失败：subagent mode does not match the supplied address（subagent/unauthorized）`
   * 拒掉历史请求（回落普通 open 时装配的地址 mode 与真实目录条目不符）。
   */
  list?: { getSnapshot(): unknown }
}

/** {@link openStepChatSessionInHost} 的结果（诊断/测试用：走的哪条通道）。 */
export type StepChatHostOpenRoute = 'subagent-address' | 'subagent-retained' | 'plain'

/**
 * 一次「在宿主中心列打开会话」的诊断记录（真机/e2e 取证用）。
 *
 * 为什么需要：三条打开通道（durable 地址 / 宿主保留地址 / 普通 open）在真机上是**静默**的——
 * 用户只看到最终会话页的报错，看不到「哪条通道被拒、DSH 抛了什么」，定位只能靠猜。这里把
 * 每次打开的通道、各通道的原始错误、durable 地址是否装配成功留成可读记录，并由
 * {@link publishStepChatOpenDiagnostics} 镜像到页面 `globalThis.__sandoreStepChatOpenDiag`，
 * 让 e2e 取证 dump 能直接输出（见 e2e/m20-finalize-badges.e2e.ts）。
 */
export interface StepChatOpenDiagnostic {
  /** ISO 时间戳。 */
  readonly at: string
  /** 目标会话 id。 */
  readonly childSessionId: string
  /** durable 直接父（宿主会话 id；未知为 undefined）。 */
  readonly parentSessionId: string | undefined
  /** 实际走的通道（`plain` = 两条子代理通道都没成）。 */
  readonly route: StepChatHostOpenRoute
  /** 各通道按尝试顺序的失败原因（DSH 抛的原始错误文本）。 */
  readonly failures: readonly string[]
  /**
   * 是否已把 durable subagent 地址装配到会话实例上（`configureSubagent` 成功）。
   *
   * `false` 且 `parentSessionId` 已知 = 后续历史请求必然退回普通地址 → 真机会报
   * `历史加载失败：subagent Sessions require their durable parent address`。
   */
  readonly transportApplied: boolean
  /** 成功那条地址用的 mode（`continuable` / `one-shot`；两条都没成时 undefined）。 */
  readonly addressMode?: StepChatSubagentMode | undefined
  /**
   * 异步「刷新父会话目录后重试」的结局（仅在想两种 mode 都被拒时发生）：
   * `ok` = 重试成功（打开已完成）、`failed` = 重试仍被拒、`skipped` = 宿主无该 API。
   * 真机诊断里若长期是 `failed`，说明该子代理不在父会话目录里（引擎侧问题，不在本模块修）。
   */
  readonly catalogRetry?: 'ok' | 'failed' | 'skipped' | undefined
  /** 刷新目录后重试成功时用的 mode（`ok` 才有值；用于区分「目录冷」与「mode 不匹配」）。 */
  readonly catalogRetryMode?: StepChatSubagentMode | undefined
  /** 打开时从 `sessions.list` 快照读到的目录条目 mode（有值 = 不必猜 mode）。 */
  readonly catalogMode?: StepChatSubagentMode | undefined
}

/** 诊断环形缓冲上限（长会话不增长；只保留最近若干次打开）。 */
export const STEP_CHAT_OPEN_DIAG_LIMIT = 50

/** 诊断镜像到页面的键名（e2e 取证读它）。 */
export const STEP_CHAT_OPEN_DIAG_GLOBAL = '__sandoreStepChatOpenDiag'

const openDiagnostics: StepChatOpenDiagnostic[] = []

/**
 * 可变诊断视图：`catalogRetry` 由**异步**重试在事后回填（其余字段创建即定），
 * 消费者只读（{@link readStepChatOpenDiagnostics} 返回的是这些对象的浅拷贝数组）。
 */
type MutableOpenDiagnostic = {
  -readonly [K in keyof StepChatOpenDiagnostic]: StepChatOpenDiagnostic[K]
}

/** 读最近的打开诊断（时间序；返回副本，调用方可安全序列化）。 */
export function readStepChatOpenDiagnostics(): readonly StepChatOpenDiagnostic[] {
  return [...openDiagnostics]
}

/** 最近一次打开诊断（无记录返回 undefined）。 */
export function lastStepChatOpenDiagnostic(): StepChatOpenDiagnostic | undefined {
  return openDiagnostics[openDiagnostics.length - 1]
}

/** 清空诊断缓冲（测试用）。 */
export function clearStepChatOpenDiagnostics(): void {
  openDiagnostics.length = 0
}

/** 把当前诊断缓冲镜像到页面全局（e2e 取证读 `globalThis.__sandoreStepChatOpenDiag`）。 */
function mirrorOpenDiagnostics(): void {
  try {
    (globalThis as Record<string, unknown>)[STEP_CHAT_OPEN_DIAG_GLOBAL] = {
      last: openDiagnostics[openDiagnostics.length - 1],
      entries: [...openDiagnostics],
    }
  } catch {
    // 无 globalThis 写入权限（受限环境）→ 只留内存缓冲，不影响打开。
  }
}

/** 记录一次打开诊断并镜像到页面全局（任何失败都不影响打开本身）。 */
function recordOpenDiagnostic(entry: StepChatOpenDiagnostic): void {
  openDiagnostics.push(entry)
  if (openDiagnostics.length > STEP_CHAT_OPEN_DIAG_LIMIT) {
    openDiagnostics.splice(0, openDiagnostics.length - STEP_CHAT_OPEN_DIAG_LIMIT)
  }
  mirrorOpenDiagnostics()
}

/** 错误 → 可读文本（DSH 抛的原始 message 优先，保留错误名便于分辨 code）。 */
function renderOpenFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? `${error.message} [${code}]` : error.message
  }
  return String(error)
}

/** 会话打开后重装 transport 的有界重试（binding 可能晚一两拍才出现）。 */
export const TRANSPORT_REAPPLY_ATTEMPTS = 20

/** 重试间隔（ms）。 */
export const TRANSPORT_REAPPLY_INTERVAL_MS = 100

/**
 * 在某会话上装配 durable 地址，**带界重试**直到 binding 出现。
 *
 * 为什么必须重试：`sessions.open(id)` 之后立刻 `sessions.binding(id)` 可能还是 undefined
 * （DSH 侧会话实例随后才挂载）——只装配一次会静默漏掉，随后页面用**普通地址**发历史请求，
 * 命中 `validateAddress` 的 `session/agent-busy`
 * （真机「历史加载失败：subagent Sessions require their durable parent address」）。
 * 这里最多等 {@link TRANSPORT_REAPPLY_ATTEMPTS} × {@link TRANSPORT_REAPPLY_INTERVAL_MS}。
 * @param sessions - sessions 服务面。
 * @param child - 目标会话 id。
 * @param parent - durable 父会话 id。
 * @param attach - 真正的装配动作（返回是否已装配成功）。
 * @returns 是否在预算内装配成功。
 */
function applyTransportWhenBound(
  sessions: StepChatHostSessionsLike,
  child: string,
  parent: string | undefined,
  attach: (session: unknown) => boolean,
): boolean {
  if (typeof sessions.binding !== 'function') return false
  const attempt = (remaining: number): boolean => {
    const session = sessions.binding?.(child)?.session
    if (session !== undefined) {
      if (attach(session)) return true
      // 装配函数拿到 session 但仍返回 false（parent 未知）→ 无解，不再重试。
      if (parent === undefined) return false
    }
    if (remaining <= 0) return false
    setTimeout(() => { attempt(remaining - 1) }, TRANSPORT_REAPPLY_INTERVAL_MS)
    return false
  }
  return attempt(TRANSPORT_REAPPLY_ATTEMPTS)
}

/**
 * 在宿主中心列打开一个（子代理）会话，并保证**打开与加载更早历史用同一个 durable 地址**。
 *
 * 通道按序尝试（每次尝试的失败原因都进 {@link StepChatOpenDiagnostic}，不再静默）：
 * ① `openSubagent(durable 地址)` —— **两种 mode 依次试**（`continuable` → `one-shot`；
 *    目录条目 mode 由子代理身份投影决定：provider 建的可续接子代理是 `continuable`，
 *    引擎裸 `agents.create` 的收尾/路由 fork 是 `one-shot`。只试一种会让一整条 lane 恒被拒
 *    → 真机 `sessions.selectSubagent: … is not a healthy catalog child`）；
 * ② `openSubagent(宿主保留地址)`（parent 未知 / ① 全被拒时的兜底，DSH 存的是该会话真实 parent）；
 * ③ 普通 `open(child)` + **装配 durable 地址**（保证随后历史请求带对地址）。
 *
 * ③ 是最后一条：即便前两条都被拒，只要 `parentSessionId` 已知就仍会 `configureSubagent`
 * 装配地址（历史加载因此仍可成功）；装配也失败时记 `transportApplied: false` +
 * `console.error`（这就是真机「历史加载失败：durable parent address」的现场）。
 *
 * **mode 必须先问目录，再决定**（2026-09-13 全量 e2e 红灯根因）：宿主目录是懒加载的
 * （`manager.setSubagentCatalogOpen(parent,true)` 只在用户打开子代理列表时拉取），目录冷时
 * 「猜 mode」会猜错——猜错的那条地址在**历史请求**上被拒：
 * `历史加载失败：subagent mode does not match the supplied address（subagent/unauthorized）`
 * （全量跑时门禁 lane 就撞上过：目录冷 + 两种候选都被拒 + 兜底猜成 `one-shot`，而门禁子代理是
 * `continuable`）。故：目录快照里没有该条目时，先 `await refreshSubagents(parent)` 再读一次，
 * 拿到**权威 mode** 后才组装地址。
 *
 * **同步性契约**：这条 `await` 只在「宿主提供 `refreshSubagents`」时才会发生；不支持刷新的
 * 宿主（含单元测试里的面板桩）下本函数**在第一个 `await` 之前就完成全部副作用**（`openSubagent`
 * /`open`/transport 装配），面板点击处理器的同步断言因此不受影响（见 {@link resolveCatalogMode}）。
 *
 * @param sessions - sessions 服务面（缺省/形状不符 → 返回 `undefined`，不抛）。
 * @param input.parentSessionId - durable 直接父（引擎 `sessionMeta.hostSessionId`；空串视为未知）。
 * @param input.childSessionId - 目标子会话 id。
 * @param input.variant - `main` = 宿主主代理会话本身（普通会话：plain open、不装 subagent 地址）。
 * @returns 实际走的通道；sessions 缺失时 undefined。
 */
export async function openStepChatSessionInHost(
  sessions: StepChatHostSessionsLike | undefined,
  input: {
    readonly parentSessionId?: string | undefined
    readonly childSessionId: string
    readonly variant?: 'subagent' | 'main' | undefined
  },
): Promise<StepChatHostOpenRoute | undefined> {
  if (sessions === undefined) return undefined
  const parent = input.parentSessionId
  const mainVariant = input.variant === 'main'
  const known = mainVariant ? undefined : catalogModeOf(sessions, parent, input.childSessionId)
  // 只有「目录里没有该条目 **且** 宿主支持刷新」才需要等待：其余情况走**完全同步**的
  // `openStepChatSessionOnKnownMode`（async 函数体在第一个 `await` 之前是同步执行的，此处该分支
  // 没有任何 `await` ⇒ `openSubagent`/`open`/transport 装配都在点击处理器里同步发生，
  // 面板单测的同步断言与真机「点击即开」的手感都不受影响）。
  if (known === undefined && !mainVariant
    && typeof sessions.refreshSubagents === 'function'
    && parent !== undefined && parent !== '') {
    return openStepChatSessionOnKnownMode(sessions, input, await resolveCatalogMode(sessions, parent, input.childSessionId))
  }
  return openStepChatSessionOnKnownMode(sessions, input, known)
}

/**
 * 打开会话的**同步**核心（{@link openStepChatSessionInHost} 的实体）：拿到
 * `catalogMode`（目录条目的真实 mode，未知则 undefined）后就地完成三条通道的尝试与 transport 装配。
 *
 * 为什么单独抽出来：`await` 即使立即 resolve 也会把后续副作用推迟一个微任务——把它留在
 * {@link openStepChatSessionInHost} 的「需要刷新目录」分支里，常见的同步路径（mode 已知 / 旧宿主
 * 无刷新面）才能保持「调用即生效」。
 */
function openStepChatSessionOnKnownMode(
  sessions: StepChatHostSessionsLike,
  input: {
    readonly parentSessionId?: string | undefined
    readonly childSessionId: string
    readonly variant?: 'subagent' | 'main' | undefined
  },
  catalogMode: StepChatSubagentMode | undefined,
): StepChatHostOpenRoute | undefined {
  const child = input.childSessionId
  const parent = input.parentSessionId
  const mainVariant = input.variant === 'main'
  const candidates = mainVariant ? [] : buildStepChatAddressCandidates(parent, child, catalogMode)
  const failures: string[] = []
  let transportApplied = false
  let addressMode: StepChatSubagentMode | undefined = catalogMode
  /** 宿主保留地址的 mode（`subagentAddress(child)`，若宿主已记过）。 */
  let retainedMode: StepChatSubagentMode | undefined
  /** 最后试过的候选 mode（两条都失败时 = 另一条；plain 兜底的 transport 用它最稳）。 */
  let lastTriedMode: StepChatSubagentMode | undefined
  let recorded: MutableOpenDiagnostic | undefined
  /** 收口：记录诊断（含失败原因）后返回通道。 */
  const finish = (route: StepChatHostOpenRoute): StepChatHostOpenRoute => {
    const entry: MutableOpenDiagnostic = {
      at: new Date().toISOString(),
      childSessionId: child,
      parentSessionId: parent,
      route,
      // **不拷贝**：异步的「刷新后重试」随后追加的失败原因也要落进同一条诊断
      //（否则真机上只看得到「打开那一刻」的原因，取不到重试结局）。
      failures,
      transportApplied,
      addressMode,
      ...(catalogMode === undefined ? {} : { catalogMode }),
    }
    recorded = entry
    recordOpenDiagnostic(entry)
    if (route === 'plain' && !mainVariant && parent !== undefined && parent !== '' && !transportApplied) {
      // 诊断硬信号：durable 父已知、两条子代理通道都没成、连地址也没装上 →
      // 历史加载必然退回普通地址报 busy（真机「历史加载失败：…durable parent address」）。
      console.error(
        `ui-sandore: step chat open left WITHOUT a durable subagent address`
        + ` (route=${route}, parent=${parent}, child=${child});`
        + ` failures=${JSON.stringify(failures)}`,
      )
    }
    return route
  }
  /** 把某条候选地址装配到会话实例上（打开成功后的「加载更早」用同一地址）。 */
  const applyTransport = (mode: StepChatSubagentMode, parentId: string | undefined): boolean =>
    applyTransportWhenBound(
      sessions,
      child,
      parentId,
      session => applyStepChatTransport(session, parentId, child, mode),
    )
  try {
    // ① 有 durable 父地址且宿主支持 openSubagent → 走「目录健康子会话」通道（两种 mode 依次试）。
    //    注：**不**优先用 `subagentAddress(child)` 的宿主保留地址——那是「parent 未知时的兜底」
    //    （见下方 ②），调换顺序会改变既有出口接线契约（step-chat-panel-paging.spec 的
    //    「无 parentSessionId 时走普通 open」用例），故保持「构造地址优先，保留地址兜底」。
    if (candidates.length > 0 && typeof sessions.openSubagent === 'function') {
      for (const candidate of candidates) {
        lastTriedMode = candidate.mode
        try {
          sessions.openSubagent(candidate)
          addressMode = candidate.mode
          transportApplied = applyTransport(candidate.mode, parent)
          return finish('subagent-address')
        } catch (error) {
          // 目录里不是「健康子会话」（mode 不匹配 / 已结算 / 目录未加载）时宿主会拒 ——
          // 回落下一条候选 / 保留地址 / 普通 open，但**仍要装配 durable 地址**（历史加载需要它）。
          failures.push(`openSubagent(${candidate.mode}): ${renderOpenFailure(error)}`)
        }
      }
      console.error(
        'ui-sandore: openSubagent refused for every address mode;'
        + ' falling back to the retained address / plain open',
        failures,
      )
      // 目录懒加载兜底：刷新父会话目录后异步重试一次（不阻塞本次打开；历史仍靠 transport 地址）。
      scheduleCatalogRetryAfterRefusal(sessions, candidates, parent, child, failures, (result, mode) => {
        if (recorded !== undefined) {
          recorded.catalogRetry = result
          if (mode !== undefined) recorded.catalogRetryMode = mode
          mirrorOpenDiagnostics()
        }
      })
    }
    // ② parent 未知时用宿主**保留的**地址兜底（DSH 存的是这条会话真实的 parent）。
    if (!mainVariant
      && typeof sessions.subagentAddress === 'function'
      && typeof sessions.openSubagent === 'function') {
      const retained = sessions.subagentAddress(child)
      if (retained !== undefined) {
        retainedMode = retained.mode
        // 保留地址与某条已试候选相同 → 已被拒过，不重复试。
        const alreadyTried = candidates.some(candidate => candidate.parentSessionId === retained.parentSessionId
          && candidate.childSessionId === retained.childSessionId
          && candidate.mode === retained.mode)
        if (!alreadyTried) {
          try {
            sessions.openSubagent(retained)
            addressMode = retained.mode
            transportApplied = applyTransport(retained.mode, retained.parentSessionId)
            return finish('subagent-retained')
          } catch (error) {
            lastTriedMode = retained.mode
            failures.push(`openSubagent(retained/${retained.mode}): ${renderOpenFailure(error)}`)
            console.error('ui-sandore: openSubagent(retained) refused; falling back to plain open', error)
          }
        } else {
          failures.push(`openSubagent(retained/${retained.mode}): skipped (same address as an already-tried candidate)`)
        }
      }
    }
    sessions.open(child)
    // 普通打开之后再装配一次（parent 已知时）：即便宿主把它当普通会话打开，历史加载也带对地址。
    // **带界重试**：binding 可能晚一两拍才挂上（见 applyTransportWhenBound 注释）。
    if (!mainVariant) {
      // 装配可能异步完成（重试窗口内）——诊断里的 `transportApplied` 记「同步是否已装上」，
      // 未装上时上面 finish 会打 console.error（真机取证靠它区分「地址错」与「地址晚到」）。
      //
      // **mode 的取值顺序（真机实证）**：目录快照 > 宿主保留地址 > **最后试过的那条候选**。
      // 最后一条很关键：`continuable` 被拒本身说明该子代理大概率不是 continuable
      // （引擎裸 `agents.create` 的收尾/路由 fork 目录条目就是 `one-shot`），用它装配 transport
      // 会被历史校验判 `subagent mode does not match the supplied address`；改用「最后试过的
      // mode」（此时= `one-shot`）即可对上。
      const mode = catalogMode ?? retainedMode ?? lastTriedMode ?? 'continuable'
      transportApplied = applyTransport(mode, parent)
      // 记「实际用于装配的 mode」（诊断里能直接看出有没有用对被拒之后的那条候选）。
      addressMode = mode
    }
    return finish('plain')
  } catch (error) {
    // 已 dispose / 未知会话：容错兜底，不向上抛（调用方可能正在关视图）。
    failures.push(`open/plain: ${renderOpenFailure(error)}`)
    console.error('ui-sandore: open step session failed (session may be disposed)', error)
    recordOpenDiagnostic({
      at: new Date().toISOString(),
      childSessionId: child,
      parentSessionId: parent,
      route: 'plain',
      failures: [...failures],
      transportApplied,
      addressMode,
      ...(recorded === undefined ? {} : { catalogRetry: recorded.catalogRetry }),
    })
    return undefined
  }
}

/**
 * 两种 mode 的 `openSubagent` 全被拒后，**异步**刷新父会话目录并重试一次（诊断闭环）。
 *
 * 为什么：宿主目录（catalog）是懒加载的（`setSubagentCatalogOpen(parent,true)` 只在用户
 * 打开子代理列表时拉取），child 刚建出来时目录里可能还没有它。
 *
 * 边界（有界）：只做**一次**刷新 + 一轮候选重试；任何失败都不抛（本次打开已由 plain +
 * transport 兜住），只把结局写进诊断；`refreshSubagents` 缺失时记 `skipped`。
 *
 * @param sessions - sessions 服务面。
 * @param candidates - 候选地址（两种 mode）。
 * @param parent - durable 父（宿主会话 id）。
 * @param child - 目标子会话 id。
 * @param failures - 本次打开的失败原因（异步重试再失败时追加）。
 * @param onResult - 结局回调（写诊断；成功时带成功的 mode）。
 */
function scheduleCatalogRetryAfterRefusal(
  sessions: StepChatHostSessionsLike,
  candidates: readonly StepChatSubagentAddress[],
  parent: string | undefined,
  child: string,
  failures: string[],
  onResult: (result: 'ok' | 'failed' | 'skipped', mode?: StepChatSubagentMode) => void,
): void {
  const refresh = sessions.refreshSubagents
  if (typeof refresh !== 'function' || parent === undefined || parent === '' || candidates.length === 0) {
    onResult('skipped')
    return
  }
  if (typeof sessions.openSubagent !== 'function') {
    onResult('skipped')
    return
  }
  void Promise.resolve(refresh.call(sessions, parent)).then(
    () => {
      for (const candidate of candidates) {
        try {
          sessions.openSubagent?.(candidate)
          applyTransportWhenBound(
            sessions,
            child,
            parent,
            session => applyStepChatTransport(session, parent, child, candidate.mode),
          )
          onResult('ok', candidate.mode)
          return
        } catch (error) {
          failures.push(`openSubagent(${candidate.mode}) after catalog refresh: ${renderOpenFailure(error)}`)
        }
      }
      onResult('failed')
    },
    () => { onResult('failed') },
  )
}

/** 会话绑定面（sessions.binding 返回；含会话对象与 scoped ctx）。 */
export interface StepChatBindingLike {
  readonly session: {
    subscribe(listener: () => void): () => void
    getSnapshot(): unknown
  }
  /** Agent-scoped ctx（沿父链可解析 app 级服务如 uiConversation）。 */
  readonly ctx?: { get?(name: string): unknown }
}

/** uiConversation（app 级）的服务形状探测面。 */
interface UiConversationLike {
  binding?(binding: unknown): { target?(name: string): unknown }
}

/**
 * chat target 的最小面（快照按 unknown 透出，由 view-node 通道读 ChatSnapshot 结构面）。
 */
interface ChatTargetLike {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** rc.1 target 快照的 ChatSnapshot 由 `createStepChatViewSource` 结构断言读取。 */

/**
 * 解析 rc.1 app 级 uiConversation.binding(binding).target('chat')。
 * @returns 具备 subscribe/getSnapshot 的 target；形状不符/抛错/缺失 → undefined。
 */
function resolveChatTarget(binding: StepChatBindingLike): ChatTargetLike | undefined {
  try {
    const ctx = binding.ctx
    const uiConversation = ctx?.get?.('uiConversation') as UiConversationLike | undefined
    const target = uiConversation?.binding?.(binding as never)?.target?.('chat') as
      | ChatTargetLike
      | undefined
    if (target !== undefined && typeof target.subscribe === 'function' && typeof target.getSnapshot === 'function') {
      return target
    }
  } catch {
    // uiConversation 形状不符/抛错 → 无 target（调用方返回 undefined → 面板空态）
  }
  return undefined
}

// ══════════════════════════════════════════════════════════════════════════════
// B1：view-node 通道——rc.1 ChatSnapshot（order/nodes/…）的直接读取面。
// 订阅粒度对齐 ChatView：
// - 整列级：target.subscribe 在装配每次 flush 时通知（覆盖全部节点更新，含按 rAF
//   合并的流式帧）——`read()` 只在此类发布后换引用，uSES 快照身份稳定；
// - 行级：`nodeSource(key)` 透出 ChatNodeStore.source(key) 的 per-key 源（同一
//   builder 实例跨发布身份稳定、只在自身节点身份变化时通知），供 B2 起行组件照抄
//   ChatNodeSeat 的订阅粒度。
// ══════════════════════════════════════════════════════════════════════════════

/** 快照引用缓存初值哨兵（区别于「从未读」与「读到 undefined」）。 */
const UNREAD_SNAPSHOT: unique symbol = Symbol('step-chat-view-unread')

/** 空列表常量（未就绪时的稳定引用；对齐 EMPTY_CHAT_SNAPSHOT 的空数组）。 */
const EMPTY_NODE_LIST: readonly StepChatViewNode[] = []
const EMPTY_UNKNOWN_LIST: readonly unknown[] = []

/**
 * 组 view-node 数据源：消费 rc.1 `uiConversation.binding(binding).target('chat')`
 * 的 ChatSnapshot（order/nodes/processSource/timeline/navigation）。
 *
 * 双缺失语义：
 * - binding/ctx 上解析不到 target → undefined（面板整体空态占位）；
 * - target 存在但快照尚未具备 ChatSnapshot 结构（未激活/无注册）→ 返回 feed，
 *   `read().ok === false` 且 order 为空——面板据此显示空态，快照就绪后
 *   同一 feed 自动翻转（订阅始终挂在 target 上）。
 *
 * 快照/节点身份缓存：
 * - `read()` 以 target 快照对象身份为准缓存（发布间同一引用，uSES 安全）；
 * - `node(key)` 以引擎节点对象身份为准缓存本地 view-node（同一节点不重建对象，
 *   行级 getSnapshot 身份稳定）；
 * - 每次发布按新 order 裁剪缓存（长会话不增长）。
 */
export function createStepChatViewSource(
  binding: StepChatBindingLike | undefined,
): StepChatViewFeed | undefined {
  if (binding === undefined) return undefined
  const target = resolveChatTarget(binding)
  if (target === undefined) return undefined

  let snapshotRef: unknown = UNREAD_SNAPSHOT
  let readCache: StepChatViewRead | undefined
  // key → { 引擎节点身份, 本地 view-node }（view-node 对象身份随底层节点稳定）。
  const viewCache = new Map<string, { raw: unknown; view: StepChatViewNode }>()
  // key → { 引擎 per-key 源身份, 包装源 }（包装源身份随引擎源稳定）。
  const sourceCache = new Map<string, {
    raw: unknown
    source: StepChatObservableSourceLike<StepChatViewNode>
  }>()

  /** 读当前快照原始值（getSnapshot 抛错与引擎「未就绪返回 undefined」同归 undefined）。 */
  const snapshotNow = (): unknown => {
    try {
      return target.getSnapshot()
    } catch {
      return undefined
    }
  }

  /** 当前快照的 ChatSnapshot 结构面（形状不符 → undefined）。 */
  const snapshotLike = (): StepChatSnapshotLike | undefined => {
    const raw = snapshotNow()
    return isStepChatSnapshotLike(raw) ? raw : undefined
  }

  /** 按新 order 裁剪节点/源缓存（order 为发布间权威 key 集）。 */
  const prune = (order: readonly string[]): void => {
    const live = new Set(order)
    for (const key of viewCache.keys()) {
      if (!live.has(key)) viewCache.delete(key)
    }
    for (const key of sourceCache.keys()) {
      if (!live.has(key)) sourceCache.delete(key)
    }
  }

  const read = (): StepChatViewRead => {
    const raw = snapshotNow()
    if (raw === snapshotRef && readCache !== undefined) return readCache
    snapshotRef = raw
    if (isStepChatSnapshotLike(raw)) {
      const order = raw.order
      prune(order)
      readCache = { ok: true, order }
    } else {
      readCache = { ok: false, order: STEP_CHAT_EMPTY_ORDER }
    }
    return readCache
  }

  const node = (key: string): StepChatViewNode | undefined => {
    const snapshot = snapshotLike()
    if (snapshot === undefined) return undefined
    const raw = snapshot.nodes.get(key)
    if (raw === undefined) return undefined
    const cached = viewCache.get(key)
    if (cached !== undefined && cached.raw === raw) return cached.view
    const view = stepChatViewNodeOf(raw)
    if (view === undefined) return undefined
    viewCache.set(key, { raw, view })
    return view
  }

  const nodeSource = (key: string): StepChatObservableSourceLike<StepChatViewNode> | undefined => {
    const snapshot = snapshotLike()
    if (snapshot === undefined) return undefined
    const rawSource = snapshot.nodes.source(key)
    if (rawSource === undefined
      || typeof rawSource.subscribe !== 'function'
      || typeof rawSource.getSnapshot !== 'function') {
      return undefined
    }
    const cached = sourceCache.get(key)
    if (cached !== undefined && cached.raw === rawSource) return cached.source
    const wrapped: StepChatObservableSourceLike<StepChatViewNode> = {
      // 值侧走本地 view-node 缓存（身份随引擎节点稳定）；订阅侧直连引擎 per-key 源
      //（只在该 key 自身变化时通知——ChatNodeSeat 的同款订阅粒度）。
      getSnapshot: () => node(key),
      subscribe: listener => rawSource.subscribe(listener),
    }
    sourceCache.set(key, { raw: rawSource, source: wrapped })
    return wrapped
  }

  const nodesSnapshot = (): readonly StepChatViewNode[] => {
    const snapshot = snapshotLike()
    if (snapshot === undefined) return EMPTY_NODE_LIST
    const views: StepChatViewNode[] = []
    for (const key of snapshot.order) {
      const view = node(key)
      if (view !== undefined) views.push(view)
    }
    return views
  }

  const processOf = (key: string): unknown => {
    const snapshot = snapshotLike()
    if (snapshot === undefined) return undefined
    const processSource = snapshot.nodes.processSource?.(key)
    if (processSource === undefined || typeof processSource.getSnapshot !== 'function') {
      return undefined
    }
    try {
      return processSource.getSnapshot()
    } catch {
      return undefined
    }
  }

  const timeline = (): unknown => snapshotLike()?.timeline

  const navigationItems = (): readonly unknown[] => {
    const snapshot = snapshotLike()
    try {
      const items = snapshot?.navigation?.items()
      return items === undefined ? EMPTY_UNKNOWN_LIST : items
    } catch {
      return EMPTY_UNKNOWN_LIST
    }
  }

  return {
    subscribe: listener => target.subscribe(listener),
    read,
    node,
    nodeSource,
    nodesSnapshot,
    processOf,
    timeline,
    navigationItems,
  }
}

// ── 视图通道的公共类型从本地契约再导出（消费方经本模块单点引用） ──────────────
export type {
  StepChatObservableSourceLike,
  StepChatSnapshotLike,
  StepChatViewFeed,
  StepChatViewLocation,
  StepChatViewNode,
  StepChatViewRead,
} from './chat-view-contract.ts'
