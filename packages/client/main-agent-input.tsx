/**
 * MainAgentInput（运行页 discussion 输入框；**独立实现**，不挂 DSH 输入内核）。
 *
 * ## 为什么是独立实现（真机验收后的决策变更）
 * 用户原话：
 * > 「工作流的 discuss 那边的输入框还是太诡异了，算了不做【已接管 DSH 会话输入壳（同一份
 * >  草稿），关闭运行视图时归还】。还是重新实现一个一模一样的输入框吧，这样也算是隔离了，
 * >  直接把 dsh 输入框抄过来」
 *
 * 上一版复用 DSH 输入内核（`conversation.input.for(actx)` → SessionInputShell）时会**争用同一个
 * 会话的编辑器根**：DSH 原生同一时刻只允许一个 DOM 根绑在编辑器上，运行页要可用就得从中心列
 * 的 InputBar 手里把根抢过来、卸载时再归还——观感与行为都"诡异"。现在改为**独立输入框**：
 * - **不挂 DSH 输入内核**（不调用 `resolveStepComposerKernel` / `conversation.input.for`）、
 *   **不碰任何 DOM 根**（不 `setRootElement`）⇒ 与 DSH 中心列的输入框彻底隔离，互不影响；
 * - 草稿是**本地 state**（不再与中心列共享/同步）；
 * - 视觉逐值照抄 `ui-conversation/src/client/skeleton/InputBar.tsx` + `InputBar.module.css`
 *   （22px 圆角卡 / 发丝描边 + 软阴影 / 16px 左内距 / 34px 圆形发送钮 / caption 占位层 /
 *   跟随深浅色与全局字号的 `--dsw-*`·`--dsh-*` 令牌），差异只有「不含 `+` 指令、模型/权限、
 *   附件、触发词菜单」这些本场景不需要的席位；
 * - 发送通道复用既有封装 `stepChatComposerSendOf(binding)`（`conversation.send` 优先 →
 *   `session.prompt(content,'queue')` 兜底），失败显示错误行；Enter 发送 / Shift+Enter 换行 /
 *   IME 组合期不发送。
 *
 * ## DOM 锚点（e2e/单测）
 * `[data-sandore-main-input]`（根）/ `[data-main-agent-input-card]`（卡）/
 * `[data-main-agent-input]`（textarea）/ `[data-main-agent-send]`（发送钮）/
 * `[data-main-agent-status]`（错误/发送中状态行）。
 * 本组件**不产出** `[data-composer-*]` 与 `[data-step-chat-composer]`（那些锚点归属 step 面板的
 * 输入壳恢复入口，见 step-view/ComposerBar.tsx 文件头），也**不产出** `[data-composer-took-root]`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-input
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  stepChatComposerCanSend, stepChatComposerErrorText, stepChatComposerFailureOf,
  type StepChatComposerPhase, type StepChatComposerResult, type StepChatComposerSend,
} from './step-view/composer-bar.ts'
import css from './main-agent-input.module.css'

/** MainAgentInput 接收的 props。 */
export interface MainAgentInputProps {
  readonly t: TranslateNS<'sandore'>
  /**
   * 发送通道（`stepChatComposerSendOf(binding)` 装配：scope conversation.send 优先、
   * `session.prompt(content,'queue')` 兜底）。缺失（宿主会话尚未就绪/通道不可用）→
   * 输入框禁用并显示状态行，绝不放任「永远发不出去」的交互。
   */
  readonly send: StepChatComposerSend | undefined
  /** 占位文案（与 DSH 一样兼作可访问名）。 */
  readonly placeholder: string
  /**
   * 动作行**左席位**（DSH InputBar 的 `.tools`）：运行页把「权限下拉」放这里
   * （DSH 同款位置；`+` 附件按用户要求不复刻）。缺省不渲染任何东西。
   */
  readonly accessory?: ReactNode
  /**
   * 模型下拉席位（发送钮**左侧**，对齐 DSH `.trailing` 顺序：模型 → 发送）。
   * **注意**：动作行里除了这两个席位与发送钮，**不再有任何按钮**——运行页的暂停/停止/中止
   * 按钮已按真机反馈全部移出（见 DiscussionInput.tsx 文件头「需求 4」）。
   */
  readonly model?: ReactNode
}

/** 发送箭头 glyph（DSH InputBar 主按钮同款 16px 路径）。 */
function SendGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

/** 失败结果 → 本地化文案（message (code) → message → code → 兜底）。 */
function errorTextOf(result: StepChatComposerResult, fallback: string): string {
  return stepChatComposerErrorText(result, fallback)
}

/**
 * 运行页 discussion 输入框（独立实现；见文件头）。
 *
 * 发送状态机：`idle → sending →`（成功清空草稿 / 失败保留草稿 + 错误行）。发送期间输入面与
 * 发送钮禁用（同 DSH 的 `machineBusy`）；再次输入即清除上次错误行（同 DSH 的 toast 族行为）。
 */
export function MainAgentInput({
  t, send, placeholder, accessory, model,
}: MainAgentInputProps) {
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState<StepChatComposerPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  // 发送原子闸（同帧连按 Enter/点击不重复投递；state 更新前的同步守卫）。
  const sendingRef = useRef(false)

  // 自动增高（DSH 的草稿随内容长高，达 --dsh-composer-text-max-height 后由 .scroll 内滚）。
  useEffect(() => {
    const area = areaRef.current
    if (area === null || area.scrollHeight === 0) return // 非布局环境（jsdom）跳过
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight}px`
  }, [draft])

  const sendLabel = phase === 'sending'
    ? t('run.step.chat.composer.sending')
    : t('run.step.chat.composer.send')
  const fallbackText = t('run.step.chat.composer.sendFailed')
  const unavailableText = t('run.mainAgent.unavailable')

  const submitDraft = async (text: string): Promise<void> => {
    if (sendingRef.current) return
    if (text.trim() === '') return
    if (send === undefined) {
      setError(unavailableText)
      return
    }
    sendingRef.current = true
    setError(null)
    setPhase('sending')
    try {
      const result = await send(text)
      if (result.ok) {
        // 仅当草稿未被并发修改时清空（发送期间用户继续输入的文本保留）。
        setDraft(current => (current === text ? '' : current))
      } else {
        setError(errorTextOf(result, fallbackText))
      }
    } catch (caught) {
      setError(errorTextOf(stepChatComposerFailureOf(caught), fallbackText))
    } finally {
      sendingRef.current = false
      setPhase('idle')
    }
  }

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setError(null) // 再次输入即清除上次失败提示（DSH toast 同族行为）
    setDraft(event.target.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 发送 / Shift+Enter 换行；IME 组合期 Enter（选词上屏）不发送。
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submitDraft(draft)
  }

  const sendable = send !== undefined && stepChatComposerCanSend(draft, phase)
  return (
    <div className={css.root} data-sandore-main-input>
      {/* 状态行：错误（role=alert）优先；无错误时显示「发送中」（role=status）。 */}
      {error !== null ? (
        <div className={css.notice} role="alert" data-main-agent-status>{error}</div>
      ) : phase === 'sending' ? (
        <div className={css.notice} role="status" data-main-agent-status>
          {t('run.step.chat.composer.sending')}
        </div>
      ) : null}
      <div className={css.card} data-main-agent-input-card>
        <div className={css.scroll} data-main-agent-input-scroll>
          <div className={css.grow}>
            <textarea
              ref={areaRef}
              className={css.input}
              rows={1}
              value={draft}
              placeholder=""
              aria-label={placeholder}
              disabled={phase === 'sending'}
              data-main-agent-input
              onChange={handleChange}
              onKeyDown={handleKeyDown}
            />
            {/* 占位层：DSH 用独立的 .placeholder 层（原生 textarea 的 placeholder 不跟随
                主题色与 `--dsh-content-font-size`，且我们要与 DSH 逐值一致）。 */}
            {draft === '' && <div className={css.placeholder} aria-hidden>{placeholder}</div>}
          </div>
        </div>
        <div className={css.row}>
          {/* 左席位：DSH InputBar 的 `.tools`（附件 `+` 按用户要求不复刻；其余席位按需）。
              权限下拉挂在这里（见 DiscussionInput.tsx 的 access 席位）。 */}
          <div className={css.tools}>
            {accessory}
          </div>
          <div className={css.trailing}>
            {/* 右席位**只有**模型下拉 + 发送钮：暂停/停止/中止按钮已按真机反馈全部移出
                （真机原话：「还是有个暂停按钮在输入框那里……去掉这个按钮」）。 */}
            <span className={css.modelSeat} data-main-agent-model>{model}</span>
            <button
              type="button"
              className={css.primary}
              aria-label={sendLabel}
              title={sendLabel}
              disabled={!sendable}
              data-main-agent-send
              onClick={() => { void submitDraft(draft) }}
            >
              <SendGlyph />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
