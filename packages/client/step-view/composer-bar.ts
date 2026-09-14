/**
 * composer-bar.ts（B4b 纯逻辑层）：step 内嵌「简化对话输入框」的
 * 可发送判定 / 发送状态机 / 发送通道装配。
 *
 * **需求 1**：面板当前**不再挂载**输入框（ComposerBar 及其模块图为唯一恢复入口，见
 * ComposerBar.tsx 文件头），本文件的展示条件/发送逻辑因此没有生产消费方——只有
 * composer-bar.spec.ts 直接驱动。历史行为如下（恢复挂载点后即为生产语义）。
 *
 * 展示条件（批 B2 放宽）：`openState==='open'` 且（`running===true` ∨ 有排队/待办语义
 * ∨ 该段是 failed 的真实子代理 step 且可重试）→ stepChatComposerShown（composer-bar.ts）。
 * 运行中为常态（排队注入）。第四项（failed 段）的理由只对**本组件自身**成立：批 B2 时
 * 重试载荷取自草稿；需求 1 把重试行移到面板底部动作位、载荷改为固定默认串后，该分支
 * 已失去产品依据（面板既有重试行又有输入框会重复），保留只为「恢复挂载点时不改变组件
 * 既有行为」；见 ComposerBar.tsx 文件头「需求 1」段。paused/completed 等其它静止态
 * 仍不显示（恢复由 step 卡片操作承担）。
 *
 * 发送通道（静态核实结论，见文件尾注释；代码里两路都留）：
 * a. binding 的 scoped ctx 上的 conversation 服务（= rc.1 ui-conversation 在
 *    根 ctx 提供的 `ConversationController`，`send(text): Promise<void>`，内部按
 *    queue 模式 `session.prompt([{type:'text',text}],'queue')`）。binding.ctx 即
 *    sessions.scope(childId) 返回的同一 Agent-scope ctx（controller 的
 *    `SessionBinding.ctx`），cordis 的 traceable 机制把方法调用重绑到该 child
 *    scope——scopeOf 解析出子代理 id，与 ui-conversation composer 的
 *    `scopedConversation(...).cancel()/send()` 完全同构，不要求 child 是当前会话。
 *    故每次调用都**现读**（不能缓存服务实例：scope 寻址依赖读取时的 ctx），且必须经
 *    `readScopeService()` 读取而**不能**直读属性——cordis 对未 inject 的服务属性读会抛
 *    `cannot get property "conversation" without inject`（真实 e2e 实测：该异常在 render
 *    期抛出，被席位 error boundary 接住，整个 RunView 被替换成原生对话列；
 *    详见 scope-service.ts 文件头）。
 * b. 兜底：`session.prompt` cast（rc.1 ISession/SessionFace prompt 形状：
 *    `prompt(content, 'queue'|'steer', signal?, requestId?) → RemoteResult`；
 *    以 dsh-api-session-controller 0.1.2-rc.1 客户端 session.ts 为准）。session 已
 *    由面板 configureSubagent 装配 subagent 地址 → prompt 内部按 address 分支路由
 *    `remote.subagents.prompt({parentSessionId, childSessionId, mode:'continuable',
 *    content})`，与 (a) 是同一宿主通道（queue/steer 参数在该路由上不区分）。
 *
 * 发送模式恒为 queue：host 侧 `subagents.prompt` 的准入码表（control.ts
 * rejectPrompt）没有「运行中 busy 拒绝」——continuable prompt 是投递进子代理的
 * FIFO inbox（接收即成功，执行异步），故 UI 语义按 rc.1 composer 的排队发送
 * （submission-policy：非 steer 能力会话恒 queue），输入框附「排队发送」提示文案
 * （ComposerBar 行内 caption）。若宿主对运行中子代理最终拒绝（如
 * subagent/parent-unavailable），失败经 promptError/结果 error 返回 → 错误行展示。
 *
 * 失败/成功形状：RemoteResult（{ok:true} | {ok:false,error:{code,message}}）或
 * (a) 抛错（conversation.send 对 !ok 结果 throw）统一归一为 StepChatComposerResult。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-bar
 */
import { readScopeService } from './scope-service.ts'

/** 发送状态机相位（组件内状态；idle→sending→idle（成功清空/失败错误行）。 */
export type StepChatComposerPhase = 'idle' | 'sending'

/** 归一化发送结果（两通道的结构读统一到此形状；失败时 code/message 尽量携带）。 */
export type StepChatComposerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code?: string | undefined; readonly message?: string | undefined }

/** 发送能力（ComposerBar 经此发送草稿；成功=已受理（排队/直达），失败=错误行）。 */
export type StepChatComposerSend = (text: string) => Promise<StepChatComposerResult>

/** binding 结构探测面（真实运行时为 SessionBinding：session + Agent-scope ctx）。 */
export interface StepChatComposerBindingLike {
  /** 子代理会话面（rc.1 SessionFace；含 prompt，结构探测）。 */
  readonly session?: unknown
  /** Agent-scoped ctx（沿父链解析 app 级服务；conversation 经 readScopeService 读取）。 */
  readonly ctx?: {
    readonly conversation?: unknown
    readonly get?: (name: string) => unknown
  } | undefined
}

/** (a) 通道的最小服务面（经探测收窄后的形状：send 必在）。 */
export interface StepChatConversationLike {
  send(text: string): Promise<unknown>
}

/** (b) 通道的最小会话面（经探测收窄后的形状：prompt 必在；rc.1 SessionFace）。 */
export interface StepChatPromptLike {
  prompt(content: readonly unknown[], mode?: string, signal?: unknown): Promise<unknown>
}

/**
 * 归一真实 binding（`sessions.binding(childId)` 的 SessionBinding）为结构探测面。
 *
 * 为什么需要：binding 是带类型的具体类（`SessionBinding`），而本模块只声明结构面
 * （sandore 不静态依赖 client-runtime 的会话类形状）；面板在把 binding 下传给
 * ComposerBar 时经此收窄，避免在组件里写 `as unknown as` 断言。
 * @param value - 面板持有的 binding（形状不合 → undefined）。
 * @returns 结构探测面，或 undefined。
 */
export function stepChatComposerBindingOf(value: unknown): StepChatComposerBindingLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly session?: unknown; readonly ctx?: unknown }
  if (record.session === undefined || typeof record.ctx !== 'object' || record.ctx === null) {
    return undefined
  }
  return record as StepChatComposerBindingLike
}

/**
 * 展示条件：open + （running ∨ 有排队/待办语义 ∨ 待重试的 failed 段）才渲染输入框。
 *
 * running 是常态（运行中排队注入）。`queued` 是批 B1 的放宽：内核路径下同一子代理
 * 会话可能仍有未消费的队列消息（`input.state.queue` 非空，例如刚注入的消息还没被
 * 下一轮取走），此时 running 短暂为 false 也不该让输入框闪没——草稿与队列都必须
 * 保持可见。`retryPending` 是批 B2 的放宽（**需求 1 起失去产品依据**）：批 B2 时
 * 「failed 的真实子代理 step」要显示输入框，因为重试行的 `message` 载荷取自这份草稿；
 * 需求 1 把重试行移到面板底部动作位（`data-step-chat-retry-seat`）、载荷改为固定默认串，
 * 面板不再有草稿，故该参数只为「恢复挂载点时保持组件既有行为」而保留（见
 * ComposerBar.tsx 文件头「需求 1」段）。paused/completed 等静止态的恢复由 step 卡片
 * 承担（不显示输入框）。
 * @param openState - 会话快照 openState。
 * @param running - 会话快照 running。
 * @param queued - 是否存在排队/待办语义（缺省 false；调用方按需传）。
 * @param retryPending - 该段是否待重试的 failed 子代理 step（缺省 false；需求 1 后无生产调用方传 true）。
 * @returns 是否渲染输入框。
 */
export function stepChatComposerShown(
  openState: string | undefined,
  running: boolean,
  queued = false,
  retryPending = false,
): boolean {
  return openState === 'open' && (running || queued || retryPending)
}

/** 可发送判定：非空草稿（trim）且不在 sending。 */
export function stepChatComposerCanSend(draft: string, phase: StepChatComposerPhase): boolean {
  return draft.trim() !== '' && phase !== 'sending'
}

/** 组 rc.1 prompt content：单文本块（conversation.send 亦同此语义）。 */
export function stepChatComposerTextParts(text: string): readonly { readonly type: 'text'; readonly text: string }[] {
  return [{ type: 'text', text }]
}

/**
 * RemoteResult 形状的结构读（session.prompt 的返回面：{ok:true} 或
 * {ok:false,error:{code,message}}；形状不符 → ok:false 无细节，调用方落 fallback）。
 */
export function stepChatComposerResultOf(value: unknown): StepChatComposerResult {
  if (typeof value !== 'object' || value === null) return { ok: false }
  const record = value as { readonly ok?: unknown; readonly error?: unknown }
  if (record.ok === true) return { ok: true }
  let code: string | undefined
  let message: string | undefined
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const detail = error as { readonly code?: unknown; readonly message?: unknown }
    if (typeof detail.code === 'string' && detail.code !== '') code = detail.code
    if (typeof detail.message === 'string' && detail.message !== '') message = detail.message
  }
  if (code === undefined && message === undefined) return { ok: false }
  return {
    ok: false,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  }
}

/** 抛错 → 失败结果（conversation.send 对 !ok 结果 throw「code: message」文本）。 */
export function stepChatComposerFailureOf(error: unknown): StepChatComposerResult {
  if (error instanceof Error && error.message !== '') return { ok: false, message: error.message }
  const text = String(error)
  if (text !== '' && text !== 'undefined') return { ok: false, message: text }
  return { ok: false }
}

/** 错误行文案：message（code 附加括号）→ message → code → fallback（本地化兜底）。 */
export function stepChatComposerErrorText(result: StepChatComposerResult, fallback: string): string {
  if (result.ok) return ''
  const { code, message } = result
  if (message === undefined) return code ?? fallback
  return code === undefined ? message : `${message} (${code})`
}

/**
 * 现读 scope ctx 上的 conversation 服务（`readScopeService`：`ctx.get` 优先、属性读回退；
 * 见文件头与 scope-service.ts）。**渲染期调用**，故任何读取异常都归一为 undefined。
 */
function conversationOf(binding: StepChatComposerBindingLike): StepChatConversationLike | undefined {
  const conversation = readScopeService(
    (binding as unknown as { ctx?: unknown }).ctx,
    'conversation',
  ) as { send?: unknown } | undefined
  if (typeof conversation?.send !== 'function') return undefined
  return conversation as StepChatConversationLike
}

/** 会话面的 prompt 探测（rc.1 SessionFace；cast 形状见文件头）。 */
function prompterOf(binding: StepChatComposerBindingLike): StepChatPromptLike | undefined {
  const session = binding.session
  if (typeof session !== 'object' || session === null) return undefined
  const prompt = (session as { prompt?: unknown }).prompt
  return typeof prompt === 'function' ? session as StepChatPromptLike : undefined
}

/**
 * 装配发送通道（a 优先 → b 兜底）：
 * - 装配期探测：scope conversation 与 session.prompt 皆缺 → undefined（调用方
 *   不渲染输入框，避免只读面板里出现永远失败的输入条）；
 * - 每次调用重新现读（a 通道属性读触发 scope 重绑；宿主 HMR/卸载后 conversation
 *   消失 → 当次调用落到 (b)，不重复尝试 (a)）。
 * 注意：conversation.send 的**业务失败**（host 拒绝）不降级到 (b)——两路是同一
 * 宿主通道，重试只会重复投递。
 */
export function stepChatComposerSendOf(
  binding: StepChatComposerBindingLike | undefined,
): StepChatComposerSend | undefined {
  if (binding === undefined) return undefined
  if (conversationOf(binding) === undefined && prompterOf(binding) === undefined) return undefined

  return async (text: string): Promise<StepChatComposerResult> => {
    // (a) Agent-scope conversation（首选；queue 语义内置在 send()）。
    const conversation = conversationOf(binding)
    if (conversation !== undefined) {
      try {
        await conversation.send(text)
        return { ok: true }
      } catch (error) {
        return stepChatComposerFailureOf(error)
      }
    }
    // (b) 兜底：session.prompt cast（queue 模式；session 已装配 subagent 地址）。
    const prompter = prompterOf(binding)
    if (prompter !== undefined) {
      try {
        const result = await prompter.prompt(stepChatComposerTextParts(text), 'queue')
        return stepChatComposerResultOf(result)
      } catch (error) {
        return stepChatComposerFailureOf(error)
      }
    }
    // 通道在装配后消失（极端竞态）：无细节失败 → 组件错误行落本地化 fallback。
    return { ok: false }
  }
}
