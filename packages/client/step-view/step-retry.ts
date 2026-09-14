/**
 * step-retry.ts（批 B2）：step 内嵌会话面板「重试」的纯逻辑层——
 * 可见性判定、模式集合、提交载荷装配、回退点选项映射、错误文案映射。
 *
 * 背景（只读参考引擎面，不改引擎）：
 * - `wire.ts` 的 `RetryStepInputSchema`：`message` **必填**、
 *   `mode: 'continue'|'revert'|'fork'`、可选 `revertBoundary`（revert 模式所选
 *   闭合 `turn/end` 的事件 seq）。
 * - `recovery-manager.ts` 的 `retryStep`：仅 `failed` 段可重试（`completed`
 *   no-op、其它状态抛 `INVALID_OPERATION`）、非子代理 step（shell 合成会话）
 *   抛 `INVALID_OPERATION`、revert/fork 需闭合 turn 边界。
 * - **F1**：failed 段的子代理 settle 后已被 DSH dispose（`getAgent(childId)`
 *   === undefined），引擎 fail-fast 抛「子代理会话已销毁…不能重试」。这条消息是
 *   现场唯一的真相，故本模块的错误映射**优先原样展示引擎文案**（不吞不译），
 *   另给一个 `disposed` 分类供面板补一句引导。
 *
 * 本模块不做任何引擎级判断（可重试性/子代理存活/边界存在与否全部由宿主兜住），
 * 只把「用户意图 → 一次 RPC 入参」与「失败 → 一行可读文案」这两件事做成纯函数，
 * 便于单测（组件只负责渲染与调用）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-retry
 */

/** 引擎 `retryStep` 的三模式（`RetryStepInputSchema.mode`）。 */
export type StepRetryMode = 'continue' | 'revert' | 'fork'

/** 模式展示顺序（继续 / 回退 / 分叉；与 DiscussionInput 的重试行一致）。 */
export const STEP_RETRY_MODES: readonly StepRetryMode[] = ['continue', 'revert', 'fork']

/**
 * 真实子代理 step 的 command 集合（= 引擎 `isSubagentStep` / client
 * `run-view-model.isSubagentStep` 的同一码表）。shell 是合成会话，引擎对它的
 * retryStep 前置拦截，UI 不该给它渲染重试入口。
 */
export const STEP_RETRY_SUBAGENT_COMMANDS: readonly string[] = ['prompt', 'agent', 'skill', 'mcp']

/**
 * 当前段定位片段（面板渲染重试行所需的 item 子集；`TimelineStepItem` 结构满足）。
 * 只取判定与寻址必需的字段，避免把整条 timeline item 下传进 composer 层。
 */
export interface StepRetryTarget {
  /** Step 定义 id（或唯一执行 id；`retryStep` 的 `stepId` 入参）。 */
  readonly stepId: string
  /** 段状态（仅 `'failed'` 可见重试行）。 */
  readonly status: string
  /** 命令类型（`sessionMeta.command`；子代理集合见上）。 */
  readonly commandType?: string | undefined
  /** 是否合成会话（shell；true 时不渲染重试行）。 */
  readonly synthetic?: boolean | undefined
  /** 执行段序号（展示用；缺省 0 = 首次执行）。 */
  readonly attemptIndex?: number | undefined
}

/** 一次重试的 RPC 入参（面板 → 端口；`revertBoundary` 仅 revert 模式携带）。 */
export interface StepRetryRequest {
  readonly stepId: string
  readonly mode: StepRetryMode
  readonly message: string
  /** revert 模式所选闭合 turn/end 事件 seq；省略 = 引擎按最后一个闭合 turn 回退。 */
  readonly revertBoundary?: number | undefined
}

/** 回退点候选的最小结构面（`RevertBoundaryOption`：seq + turn + 文本预览）。 */
export interface StepRetryBoundaryOptionLike {
  /** 闭合 `turn/end` 的事件 seq（回传为 `revertBoundary`）。 */
  readonly seq: number
  /** turn 编号（展示为 `Turn {n+1}`）。 */
  readonly turn: number
  /** assistant 文本预览（可选；本面板不展示，保留结构以直传宿主数据）。 */
  readonly preview?: string | undefined
}

/**
 * 上层（RunView）装配的重试调用面：只有两个既有 RPC 的薄封装，**不知道**当前段是
 * 哪一段——段定位（stepId/status/commandType/synthetic）由时间线逐行补上，拼成
 * `StepChatRetryPort` 后才交给面板（一个实例的多个 step 卡共用同一份调用面）。
 */
export interface StepRetryActions {
  /** 提交一次重试（`remote.retryStep` 的薄封装；失败拒绝，面板据此出错误行）。 */
  retry(input: StepRetryRequest): Promise<void>
  /** 拉取 revert 模式回退点候选（`remote.listRevertBoundaries`；失败拒绝）。 */
  listBoundaries(stepId: string): Promise<readonly StepRetryBoundaryOptionLike[]>
}

/**
 * 面板持有的重试端口：目标段片段 + 两个既有 RPC 的调用面（**零新 RPC**）。
 *
 * `retry` 失败时**拒绝**（面板据此渲染 `data-step-chat-retry-error` 错误行，
 * 文案取引擎 message）；`listBoundaries` 是同名只读查询，失败同样拒绝。
 */
export interface StepChatRetryPort extends StepRetryActions {
  /** 本段定位片段（可见性判定用）。 */
  readonly target: StepRetryTarget
}

/** 重试模式 → locales 键（复用 DiscussionInput 既有 `run.retry.mode.*`，zh/en 对称）。 */
export type StepRetryModeLabelKey =
  | 'run.retry.mode.continue'
  | 'run.retry.mode.revert'
  | 'run.retry.mode.fork'

/**
 * 重试行的可见性：仅「failed 的真实子代理 step」。
 *
 * 三条都必要：
 * 1. `status === 'failed'`——引擎只重试 failed 段（completed no-op、其它状态抛错）；
 * 2. `synthetic !== true`——shell 合成会话没有可控子代理，引擎前置拦截；
 * 3. `commandType` 落在子代理码表内——与引擎 `isSubagentStep` 同判据；
 * 4. `stepId` 非空——空 id 无从寻址（防御，正常数据不会出现）。
 * @param target - 段定位片段（缺省 → 不可见）。
 * @returns 是否渲染重试行。
 */
export function stepRetryVisible(target: StepRetryTarget | undefined): boolean {
  if (target === undefined) return false
  if (target.status !== 'failed') return false
  if (target.synthetic === true) return false
  if (target.stepId.trim() === '') return false
  return STEP_RETRY_SUBAGENT_COMMANDS.includes(target.commandType ?? '')
}

/**
 * 模式 → locales 键（组件 `t(key)` 取文案；避免在 JSX 里写嵌套三元）。
 * @param mode - 重试模式。
 * @returns 该模式的文案键。
 */
export function stepRetryModeLabelKey(mode: StepRetryMode): StepRetryModeLabelKey {
  return mode === 'continue'
    ? 'run.retry.mode.continue'
    : mode === 'revert' ? 'run.retry.mode.revert' : 'run.retry.mode.fork'
}

/**
 * 提交载荷里的 `message`：草稿可用则原样用草稿（不 trim——用户排版的换行/空格
 * 属于内容，引擎把它当提示消息原样投递），全空白（未输入/全是空白字符）或非
 * 字符串才回退到本地化默认串（`message` 在 wire 上必填，不能为空串）。
 *
 * 需求 1 起面板没有输入面（草稿概念消失），`StepRetryRow` 恒传空串 → 恒走
 * `defaultMessage` 分支；本函数保留双分支是因为它仍是唯一的装配点，且在「恢复
 * 面板输入框」或其它调用方（DiscussionInput 同族）接回草稿时不需要改这里。
 * @param draft - 当前草稿（面板恒为 `''`；内核 `state.draft` / textarea 值等其它调用方可传真实草稿）。
 * @param defaultMessage - 本地化默认串（`run.step.chat.retry.defaultMessage`）。
 * @returns 送进 `retryStep` 的 message。
 */
export function stepRetryMessageOf(draft: string, defaultMessage: string): string {
  return typeof draft === 'string' && draft.trim() !== '' ? draft : defaultMessage
}

/**
 * 装配一次重试的 RPC 入参。
 *
 * `revertBoundary` 只在 `mode === 'revert'` 且用户明确选了某个闭合 turn 时携带
 * （`'default'` = 未选 → 省略该键，交引擎按 `computeSafeRevertBoundary` 取默认
 * 边界；continue/fork 绝不携带——fork 的边界由引擎自行决定，用户选择对它无意义）。
 * @param target - 段定位片段（取 `stepId`）。
 * @param mode - 所选模式。
 * @param draft - 当前草稿。
 * @param options - 默认 message 等本地化兜底（`defaultMessage`）。
 * @param revertBoundary - revert 下拉所选 seq（缺省 = 默认边界）。
 * @returns `remote.retryStep` 的入参。
 */
export function stepRetryRequestOf(
  target: StepRetryTarget,
  mode: StepRetryMode,
  draft: string,
  options: { readonly defaultMessage: string },
  revertBoundary?: number,
): StepRetryRequest {
  const message = stepRetryMessageOf(draft, options.defaultMessage)
  const boundary = mode === 'revert' ? revertBoundary : undefined
  return {
    stepId: target.stepId,
    mode,
    message,
    ...(boundary === undefined ? {} : { revertBoundary: boundary }),
  }
}

/**
 * 回退点候选归一：丢弃 `seq`/`turn` 非有限数字的条目（宿主数据形状探测），保序。
 * 组件按返回数组渲染 `<option>`（`seq` 为值、`Turn {turn+1}` 为文案）。
 * @param options - 宿主返回的候选（或缺省）。
 * @returns 可用候选（可能为空数组）。
 */
export function stepRetryBoundaryOptionsOf(
  options: readonly StepRetryBoundaryOptionLike[] | undefined,
): readonly StepRetryBoundaryOptionLike[] {
  if (options === undefined) return []
  const entries: StepRetryBoundaryOptionLike[] = []
  for (const option of options) {
    if (option === null || typeof option !== 'object') continue
    if (!Number.isFinite(option.seq) || !Number.isFinite(option.turn)) continue
    entries.push({
      seq: option.seq,
      turn: option.turn,
      ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
    })
  }
  return entries
}

/** 回退点下拉的「默认」选项值（= 不传 `revertBoundary`，引擎取最后一个闭合 turn）。 */
export const STEP_RETRY_BOUNDARY_DEFAULT = 'default'

/**
 * 下拉当前值：未选（undefined）→ `'default'`；否则 seq 的字符串形式。
 * @param boundary - 当前所选 seq。
 * @returns `<select value>` 的值。
 */
export function stepRetryBoundarySelectValue(boundary: number | undefined): string {
  return boundary === undefined || !Number.isFinite(boundary)
    ? STEP_RETRY_BOUNDARY_DEFAULT
    : String(boundary)
}

/**
 * 下拉值 → `revertBoundary`：`'default'`（或非法值）→ undefined（不携带该键），
 * 合法数字字符串 → 数值。
 * @param value - `<select>` 的 value。
 * @returns 所选 seq，或 undefined（默认边界）。
 */
export function stepRetryBoundaryOf(value: string): number | undefined {
  if (value === '' || value === STEP_RETRY_BOUNDARY_DEFAULT) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 重试失败的错误分类（供面板在 F1 场景补一句引导文案）。 */
export type StepRetryErrorKind = 'disposed' | 'other'

/**
 * F1 判据：引擎「子代理会话已销毁」族文案（recovery-manager 的 fail-fast 原话，
 * 以及 DSH 侧 NOT_RESUMABLE/disposed 的同义英文措辞）。仅用于**附加**引导文案，
 * 绝不用于改写或替换引擎原文。
 */
const STEP_RETRY_DISPOSED_PATTERNS: readonly RegExp[] = [
  /子代理会话已销毁/,
  /NOT_RESUMABLE/,
  /has been disposed|is disposed|was disposed/i,
]

/**
 * 错误 → 展示文案：**引擎原文优先**（`Error.message`，如
 * `INVALID_OPERATION: step 'x' 的子代理会话已销毁（…），不能重试`），
 * 无 message 才落本地化兜底（保持错误行恒有内容）。
 * @param error - `port.retry` 拒绝的原因（SandoreRemoteError / Error / 任意值）。
 * @param fallback - 本地化兜底文案（`run.step.chat.retry.failed`）。
 * @returns 错误行文案。
 */
export function stepRetryErrorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '' && error !== 'undefined') return error
  return fallback
}

/**
 * 错误分类（F1 → `'disposed'`）。
 * @param error - `port.retry` 拒绝的原因。
 * @returns `'disposed'`（子代理会话已销毁族）或 `'other'`。
 */
export function stepRetryErrorKind(error: unknown): StepRetryErrorKind {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STEP_RETRY_DISPOSED_PATTERNS.some(pattern => pattern.test(text)) ? 'disposed' : 'other'
}

/** 回退点区的状态（面板内 state；纯数据，便于单测文案分支）。 */
export type StepRetryBoundariesState =
  /** 非 revert 模式（不拉取）。 */
  | { readonly kind: 'idle' }
  /** 拉取中。 */
  | { readonly kind: 'loading' }
  /** 拉到候选（可能为空数组 = 无闭合 turn）。 */
  | { readonly kind: 'ready'; readonly options: readonly StepRetryBoundaryOptionLike[] }
  /** 拉取失败（面板显示降级文案 + 引擎/宿主错误原文）。 */
  | { readonly kind: 'error'; readonly message: string }

/** 回退点区的降级文案（key + 可选原文；组件 `t(key)` 本地化）。 */
export type StepRetryBoundaryHint =
  | { readonly kind: 'loading'; readonly key: 'run.retry.boundary.loading' }
  | { readonly kind: 'empty'; readonly key: 'run.retry.boundary.empty' }
  | {
    readonly kind: 'error'
    readonly key: 'run.step.chat.retry.boundariesFailed'
    readonly message: string
  }

/**
 * 回退点区的提示行：拉取中 / 空（无闭合 turn）/ 拉取失败的降级文案；
 * `idle` 与「有候选」时无提示（下拉本身就是选项清单）。
 * @param state - 回退点区状态。
 * @returns 提示（或 undefined 不渲染）。
 */
export function stepRetryBoundaryHintOf(
  state: StepRetryBoundariesState,
): StepRetryBoundaryHint | undefined {
  if (state.kind === 'loading') return { kind: 'loading', key: 'run.retry.boundary.loading' }
  if (state.kind === 'error') {
    return { kind: 'error', key: 'run.step.chat.retry.boundariesFailed', message: state.message }
  }
  if (state.kind === 'ready' && state.options.length === 0) {
    return { kind: 'empty', key: 'run.retry.boundary.empty' }
  }
  return undefined
}

/**
 * revert 模式的轻量提示：候选已拉到但为空（该子代理会话没有闭合 turn/end）——
 * 提交仍放行（引擎可能仍有可回退边界或自行报错），但先提示用户这不是正常可回退态。
 * 注释（任务书要求）：用 `listRevertBoundaries` 的空结果判断，不额外探测会话事件。
 * @param state - 回退点区状态。
 * @param mode - 当前所选模式。
 * @returns 是否显示轻量提示行。
 */
export function stepRetryRevertUnavailable(
  state: StepRetryBoundariesState,
  mode: StepRetryMode,
): boolean {
  return mode === 'revert' && state.kind === 'ready' && state.options.length === 0
}
