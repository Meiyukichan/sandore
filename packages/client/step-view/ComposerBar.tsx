/**
 * ComposerBar（B1 step-view 版）：step 内嵌会话面板的「同风格对话输入框」——
 * **复用 DSH 输入内核 + 自绘壳**。
 *
 * ## 需求 1：面板当前**不再挂载**本组件（保留为唯一恢复入口）
 * 产品要求「step 面板里的输入框去掉」，实现方式是**移除 StepChatPanel / StepChatBody
 * 的挂载点**（`data-step-chat-composer-seat` 与 composerSend/composerBinding/
 * hostSessionId 三个接线 props 一并删除），而不是把本组件掏空成恒 null——所以本文件
 * 及其模块图（composer-bar.ts / composer-trigger-menu.ts / composer-decorators.tsx /
 * composer-keydown.ts / dsh-composer.ts / composer-bar.module.css）**逐字保留**。
 * 想恢复面板内输入框时只需在 StepChatBody 里把挂载点加回一处（注意：重试行现在住在
 * 面板自己的 `data-step-chat-retry-seat` 里，恢复时不要把 retry 端口再传进来，
 * 否则会同时出现两份重试行）。
 * 因此：本组件里的**键盘/菜单/排队提示/发送状态机/只读守卫**在当前版本没有生产
 * 挂载点，仅由 `step-view/*.spec.ts` 的组件级用例守护（composer-bar-render /
 * composer-trigger-menu-render / composer-keydown / dsh-composer / step-retry-row）。
 *
 * 视觉对齐 DSH 0.1.2-rc.1 ui-conversation skeleton/InputBar + InputBar.module.css
 * （只读参考 deepseek-harness；不 import 组件）：22px 圆角卡 + l2 发丝描边 +
 * 软阴影 + 输入面底 + 34px 圆形发送钮（逐值见 composer-bar.module.css）。
 * 自绘壳**结构性地不含** DSH InputBar 的 `+`（指令）按钮——本批的天然结果：那个
 * 按钮在 DSH 里是硬编码无开关的（InputBar.tsx 的 `.tools > .add`），我们不渲染它。
 *
 * 双路（本批核心）：
 * - **内核可用**（`resolveStepComposerKernel(binding)` 拿到面）：文本面用 DSH 的
 *   Lexical 编辑器（`editor.setRootElement(el)` 绑到自绘壳里的 contenteditable div，
 *   `editor.setEditable(bool)` 控制只读），状态/草稿订阅 `kernel.state`（uSES），发送
 *   走 `kernel.submit('queue')`；键盘走 **DOM capture 拦截**（composer-keydown.ts：
 *   lexical 的命令层按对象身份索引，第二份副本注册会静默失效）；chip（@step 引用）
 *   经 decorator portal 渲染（composer-decorators.tsx）。
 * - **内核缺失**（旧宿主/非 web 宿主/`for()` 抛错）：**保留 B4b 的 textarea 实现**
 *   作为降级——行为不变（Enter 发送 / Shift+Enter 换行 / IME 守卫 / 发送中禁用 /
 *   错误行保留草稿），发送经 `stepChatComposerSendOf` 装配的 conversation.send 优先
 *   / session.prompt('queue') 兜底通道。降级路径只在探测失败时出现，不影响新宿主。
 *
 * 编辑器根独占（守卫，两道）：
 * 1. **绑定前**（批 B2）：宿主原生对话页正显示该子代理会话时（`sessions.list` 的
 *    `current === 本卡 childSessionId`，经 `hostSessionId` prop 下传），宿主页的
 *    InputBar 会绑同一个根；两者挂载顺序不定，本卡若先绑就会把根抢走（宿主页输入框
 *    随后不可编辑/内容错位）——故命中即**不绑内核**（只读 + 发送禁用，留 DOM 痕迹
 *    `data-composer-host-claimed`），把根完整留给宿主页。判定见
 *    dsh-composer.ts 的 `stepComposerHostClaimsRoot`。
 * 2. **绑定后发现**：根已被**别的**元素占用（宿主的 InputBar 先绑上了）→ 不抢根，本
 *    卡只读（不 setRootElement、不 setDraft、只在注释与 DOM 上留痕），发送钮禁用——
 *    避免把宿主页的输入框内容搬到 step 卡里。卸载仅当根仍属本元素时
 *    `setRootElement(null)`。
 *
 * 展示条件（批 B2 放宽）：`openState==='open'` 且（`running===true` ∨ 有排队/待办语义
 * ∨ 待重试的 failed 段）→ stepChatComposerShown（composer-bar.ts）。**注意**：这条
 * 「failed 段保留输入框」的理由（重试载荷取自草稿）已随需求 1 失效——重试 message
 * 现在是固定默认串（见 step-view/StepRetryRow.tsx 头注释），面板也不再有草稿。
 * 该分支留在本组件里只为「恢复挂载点时不改变既有组件行为」，生产路径不经过它。
 *
 * 发送语义恒为 queue（`stepComposerSubmitMode()`；见 composer-bar.ts 的宿主准入说明）。
 *
 * ## 运行页不复用本组件（决策变更后）
 * 本批一度把本组件挂到**运行页**当「主代理会话的输入壳」（共享草稿 + 接管编辑器根 + 卸载归还），
 * 真机验收被用户否决（观感与行为都"诡异"）。运行页现在用
 * `packages/client/main-agent-input.tsx` 的**独立输入框**：不挂 DSH 输入内核、不接触任何编辑器
 * 根、草稿是本地 state。故本组件里那套「主代理席位」参数（`forceShow` / `owner` / `takeRoot` /
 * `trailing` / `queueHint` / `placeholder` / `onSubmitted`）与**根接管/归还逻辑已整块删除**
 * ——它回到「step 面板输入壳的恢复入口」这一单一职责（见上方「需求 1」段），
 * 当前没有任何生产挂载点。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/ComposerBar
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  stepChatComposerCanSend,
  stepChatComposerErrorText,
  stepChatComposerFailureOf,
  stepChatComposerShown,
  type StepChatComposerBindingLike,
  type StepChatComposerPhase,
  type StepChatComposerResult,
  type StepChatComposerSend,
} from './composer-bar.ts'
import {
  resolveStepComposerKernel,
  stepComposerCanSubmit,
  stepComposerHostClaimsRoot,
  stepComposerPhaseBusy,
  stepComposerSubmitMode,
  type StepComposerInputStateLike,
  type StepComposerKernel,
} from './dsh-composer.ts'
import { StepComposerDecorators } from './composer-decorators.tsx'
import { bindStepComposerKeydown } from './composer-keydown.ts'
import {
  stepComposerMenuTitleOf,
  stepComposerTriggerOf,
  type StepComposerTriggerControllerLike,
} from './composer-trigger-menu.ts'
import { ComposerTriggerMenu } from './ComposerTriggerMenu.tsx'
import { StepRetryRow } from './StepRetryRow.tsx'
import type { StepChatRetryPort } from './step-retry.ts'
import css from './composer-bar.module.css'

/** 触发词控制器探测的重试间隔（服务/作用域可能晚于首帧出现；见 useStepComposerTrigger）。 */
const TRIGGER_PROBE_MS = 500
/** 探测次数上限（500ms × 60 = 30s；超出即视为该宿主没有触发词管线，不再重试）。 */
const TRIGGER_PROBE_MAX = 60

/**
 * 解析本面板会话的触发词控制器（`@`/`/` 候选菜单的状态面）。
 *
 * 为什么要重试：`ctx.inputTriggers`（ui-input-trigger）与会话作用域都可能**晚于**
 * 面板首帧就绪，一次性解析会永久拿到 undefined（那样菜单永远不出现）。探测是廉价纯
 * 读取（`sessions.scope` + `sessionOf`），故有界轮询：命中即停，30s 未命中即放弃
 * （降级为「无菜单」，输入/发送完全不受影响）。
 * @param sessionId - 本面板的子代理会话 id。
 * @returns 控制器只读面，或 undefined（降级）。
 */
function useStepComposerTrigger(sessionId: string | undefined): StepComposerTriggerControllerLike | undefined {
  const [controller, setController] = useState<StepComposerTriggerControllerLike | undefined>(
    () => stepComposerTriggerOf(sessionId),
  )
  useEffect(() => {
    setController(stepComposerTriggerOf(sessionId))
    if (sessionId === undefined || sessionId === '') return undefined
    if (stepComposerTriggerOf(sessionId) !== undefined) return undefined
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const live = stepComposerTriggerOf(sessionId)
      if (live !== undefined) {
        setController(live)
        return
      }
      attempts += 1
      if (attempts >= TRIGGER_PROBE_MAX) return
      timer = setTimeout(tick, TRIGGER_PROBE_MS)
    }
    timer = setTimeout(tick, TRIGGER_PROBE_MS)
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId])
  return controller
}

/** ComposerBar 的 props（展示条件 + 发送通道 + 绑定 + 重试端口 + 本地化）。 */
export interface ComposerBarProps {
  /** 会话快照 openState（'open' 才显示输入框；loading/error/cold 由面板占位承担）。 */
  readonly openState: string | undefined
  /** 会话快照 running（运行中才允许注入——排队语义，见 composer-bar.ts）。 */
  readonly running: boolean
  /**
   * 降级发送通道（stepChatComposerSendOf 装配；内核可用时仅作展示条件判定）。
   */
  readonly send: StepChatComposerSend
  /**
   * 会话绑定（`sessions.binding(childId)`）：内核探测的入口（`binding.ctx` 即
   * `sessions.scope(childId)` 的 Agent-scope ctx）。缺失 → 恒走降级 textarea。
   */
  readonly binding?: StepChatComposerBindingLike | undefined
  /**
   * 批 B2：本卡的子代理会话 id（= StepChatPanel 的 sessionId）。只用于宿主根抢占
   * 判定（`hostSessionId === sessionId`），不参与发送/寻址。
   */
  readonly sessionId?: string | undefined
  /**
   * 批 B2：宿主会话列表的 `current`（`sessions.list.getSnapshot().current`，即宿主
   * 原生对话页正在显示的会话 id）。等于 `sessionId` → 宿主页占着同一个输入壳，
   * 本卡不绑内核（见文件头的两道守卫）。
   */
  readonly hostSessionId?: string | undefined
  /**
   * 批 B2：重试端口（仅在「failed 的真实子代理 step」时由上层传入）——传了就在输入
   * 卡上方渲染重试行（模式/回退点/重试按钮）。提交 message 是固定默认串（需求 1：
   * 面板已无草稿，见 StepRetryRow.tsx 头注释）。
   */
  readonly retry?: StepChatRetryPort | undefined
  readonly t: TranslateNS<'sandore'>
}

/** 错误/结果归一失败 → 本地化兜底文案（保持错误行恒有内容）。 */
function failureText(error: unknown, fallback: string): string {
  return stepChatComposerErrorText(stepChatComposerFailureOf(error), fallback)
}

/** 草稿 → 发送结果（供状态行；结果 ok 不产文案）。 */
function outcomeText(result: StepChatComposerResult, fallback: string): string {
  return stepChatComposerErrorText(result, fallback)
}

/** 空状态兜底（内核尚未发布首帧时的默认草稿/相位）。 */
const EMPTY_INPUT_STATE: StepComposerInputStateLike = { draft: '', phase: 'plain' }

/**
 * 「发送箭头」glyph（rc.1 InputBar 主按钮同款；自绘壳的发送钮内容）。
 * @returns 16px 发送箭头 svg。
 */
function SendGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

/**
 * 内核路径的 composer（内容见文件头的「双路」）。
 *
 * 只在内核探测成功时渲染；壳结构与降级路径一致（.root/.card/.row/.queueHint/.send），
 * 差别只在文本面（contenteditable + Lexical）与发送动作（kernel.submit）。批 B2：
 * 重试行在卡**上方**（`retry` 端口传入时），文本面还多两个只读分支——
 * `hostClaimsRoot`（宿主对话页占着根，绑定前守卫）与「根已被别人占用」（绑定后发现）。
 */
function KernelComposer({ kernel, retry, hostClaimsRoot, sessionId, t }: {
  readonly kernel: StepComposerKernel
  /** 批 B2：重试端口（缺省 = 不渲染重试行）。 */
  readonly retry?: StepChatRetryPort | undefined
  /** 批 B2：宿主原生对话页占着同一个输入壳（绑定前守卫命中）。 */
  readonly hostClaimsRoot: boolean
  /** 批 B3：本面板的子代理会话 id（触发词菜单的控制器按会话解析）。 */
  readonly sessionId?: string | undefined
  readonly t: TranslateNS<'sandore'>
}) {
  // 输入状态（uSES 订阅内核的可观察面：草稿/相位/claim/队列；首帧未发布 → 空状态）。
  const state = useSyncExternalStore(
    useCallback(listener => kernel.state.subscribe(listener), [kernel]),
    useCallback(() => kernel.state.getSnapshot(), [kernel]),
    useCallback((): StepComposerInputStateLike => EMPTY_INPUT_STATE, []),
  )
  const busy = stepComposerPhaseBusy(state.phase)
  const sendable = stepComposerCanSubmit(state)
  // 文本面状态（编辑器根独占 + 只读）：
  // - 'pending'  首帧尚未跑绑定 effect（不渲染可编辑面、不建键盘监听）；
  // - 'claimed'  本卡持有根元素（可编辑，除非相位忙碌）；
  // - 'readonly' 根已被别处占用（宿主的 InputBar 先绑上了）→ 不抢根、只读；
  // - 'host'     宿主原生对话页正显示该子代理会话（绑定**前**守卫）→ 不绑内核、只读，
  //              根完整留给宿主页（批 B2；判定见 stepComposerHostClaimsRoot）。
  // 用单一状态而非多个 boolean：绑定 effect 是唯一的写入者，避免「先可编辑再被降级」
  // 的中间帧（那会让内容在原生页与本卡之间抖动）。
  const [surface, setSurface] = useState<'pending' | 'claimed' | 'readonly' | 'host'>('pending')
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 批 B3：触发词菜单（`@step` 等）——控制器按会话解析；缺失即不渲染菜单（见 hook 注释）。
  const trigger = useStepComposerTrigger(sessionId)

  const placeholderText = t('run.step.chat.composer.placeholder')
  const sendLabel = busy
    ? t('run.step.chat.composer.sending')
    : t('run.step.chat.composer.send')

  // 文本面绑定：setRootElement(el) + setEditable(bool)（两步即可，见 dsh-composer.ts）。
  // 卸载 setRootElement(null) 释放根元素（仅当根仍属本元素）；根被宿主页占用时本轮
  // 改为只读并留痕。
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return undefined
    // 批 B2 绑定前守卫：宿主会话列表 current 就是本子代理会话 → 宿主原生对话页正显示
    // 它，根归宿主页的 InputBar（挂载顺序不定，抢根会让宿主页输入框失效）。
    if (hostClaimsRoot) {
      setSurface('host')
      return undefined
    }
    const existing = kernel.editor.getRootElement()
    if (existing !== null && existing !== el) {
      // 根已被别处占用（同一子代理会话在宿主原生对话页开着）——不抢根：本卡只读。
      setSurface('readonly')
      return undefined
    }
    kernel.editor.setRootElement(el)
    setSurface('claimed')
    return () => {
      if (kernel.editor.getRootElement() === el) kernel.editor.setRootElement(null)
      setSurface('pending')
    }
  }, [kernel, hostClaimsRoot])

  // 只读态同步（提交中/锁定/根被占用时锁住编辑器自身闸门）。
  useEffect(() => {
    kernel.editor.setEditable(surface === 'claimed' && !busy)
  }, [kernel, surface, busy])

  // 键盘拦截：编辑器根元素的**父节点** capture 阶段（见 composer-keydown.ts 的取向）。
  // 依赖 surface（而非 ref）：根绑定完成的同一提交里就挂上监听，不会漏掉首帧按键。
  const canSubmit = useCallback(() => stepComposerCanSubmit(kernel.state.getSnapshot()), [kernel])
  useEffect(() => {
    const el = rootRef.current
    if (el === null || surface !== 'claimed') return undefined
    const handle = bindStepComposerKeydown(el, {
      getRootElement: () => kernel.editor.getRootElement(),
      arbitrate: (key, composing) => kernel.arbitrate(key, composing),
      space: () => kernel.space(),
      canSubmit,
      submit: () => { kernel.submit(stepComposerSubmitMode()) },
    })
    return () => { handle.dispose() }
  }, [kernel, surface, canSubmit])

  // 外点交互关掉 popupSelect 壳（rc.1 composer 同款：点在卡外即 dismiss）。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const el = rootRef.current
      const target = event.target
      if (el === null || !(target instanceof Node)) return
      if (el.closest('[data-step-chat-composer]')?.contains(target) === true) return
      kernel.dismissPopup()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [kernel])

  const editable = surface === 'claimed' && !busy
  const effectiveReadOnly = surface !== 'claimed'

  return (
    <div className={css.root} data-step-chat-composer data-composer-kernel="dsh">
      {/* 批 B2：重试行在输入卡**上方**（需求 1 起 message 为固定默认串——面板
          已无草稿可作载荷，见 StepRetryRow.tsx 头注释）。
          只在宿主传入 retry 端口（failed 的真实子代理 step）时渲染。 */}
      {retry !== undefined && <StepRetryRow port={retry} t={t} />}
      {busy && (
        <div className={css.statusInfo} role="status" data-composer-status>
          {t('run.step.chat.composer.sending')}
        </div>
      )}
      {surface === 'host' || surface === 'readonly' ? (
        // 只读留痕：宿主对话页占着这个输入壳（'host' = 绑定前守卫命中，
        // 'readonly' = 绑定后发现根已被别人占用）。文案说明为什么不能输入，
        // 避免用户把它当成坏掉的输入框。
        <div className={css.statusInfo} role="status" data-composer-readonly-hint>
          {t('run.step.chat.composer.readonly')}
        </div>
      ) : null}
      <div className={css.menuAnchor} data-composer-menu-anchor>
        {/* 批 B3：触发词候选浮层（`@step` 引用菜单）。锚在本容器上（= 输入卡宽度），
            定位与 DSH 的会话页 composer 菜单同款（bottom: 100% + 4px，左右 0）。
            注（需求 2）：`@step` 已整体退役——装配侧不再安装控制器，故生产环境恒不挂载。 */}
        {trigger === undefined
          ? null
          : <ComposerTriggerMenu controller={trigger} t={t} titleOf={stepComposerMenuTitleOf} />}
        <div className={css.card}>
          {/* 文本面：DSH 输入内核的 contenteditable 宿主。占位用 CSS `:empty::before`
              （rc.1 的 .placeholder 层等价物；无镜像层需求）。 */}
          <div
            ref={rootRef}
            className={css.editor}
            contentEditable={editable}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={placeholderText}
            aria-disabled={effectiveReadOnly || undefined}
            data-composer-input
            data-placeholder={placeholderText}
            data-composer-readonly={effectiveReadOnly || undefined}
            data-composer-host-claimed={surface === 'host' || undefined}
          />
          {/* chip（@step 引用）的 portal 圈：把 decorator 的 React 面渲染进各自宿主元素。 */}
          <StepComposerDecorators editor={kernel.editor} />
          <div className={css.row}>
            <span className={css.queueHint} data-composer-queue-hint>
              {t('run.step.chat.composer.queueHint')}
            </span>
            {/* 自绘壳**不含** `+`（指令）按钮与模型/权限/附件席位——结构性差异，见文件头。 */}
            <button
              type="button"
              className={css.send}
              aria-label={sendLabel}
              title={sendLabel}
              disabled={!sendable || effectiveReadOnly}
              data-composer-send
              onClick={() => { kernel.submit(stepComposerSubmitMode()) }}
            >
              <SendGlyph />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 降级路径的 composer（B4b 原实现原样保留）：native textarea + 受控草稿 +
 * 发送状态机。内核不可用（旧宿主/探测失败）时的**行为等价**兜底，键盘语义与内核
 * 路径一致（Enter 发送、Shift+Enter 换行、IME 组合期不发送）。
 */
function FallbackComposer({ send, retry, t }: {
  readonly send: StepChatComposerSend
  /** 批 B2：重试端口（缺省 = 不渲染重试行）。 */
  readonly retry?: StepChatRetryPort | undefined
  readonly t: TranslateNS<'sandore'>
}) {
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState<StepChatComposerPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  // 发送原子闸（同帧连按 Enter/点击不重复投递；state 更新前的同步守卫）。
  const sendingRef = useRef(false)

  // 自动增高：rc.1 草稿随内容长高，达 --dsh-composer-text-max-height 后内滚
  // （textarea overflow-y auto + max-height 在 CSS；此处只同步高度）。
  useEffect(() => {
    const area = areaRef.current
    if (area === null || area.scrollHeight === 0) return // 非布局环境（jsdom）跳过
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight}px`
  }, [draft])

  const placeholderText = t('run.step.chat.composer.placeholder')
  const sendLabel = phase === 'sending'
    ? t('run.step.chat.composer.sending')
    : t('run.step.chat.composer.send')
  const fallbackText = t('run.step.chat.composer.sendFailed')

  // 发送状态机：idle → sending（禁用按钮+发送中文案）→ 成功清空草稿 / 失败错误行
  // （草稿保留可重发；错误在再次输入时清除）。
  const submitDraft = async (text: string): Promise<void> => {
    if (sendingRef.current) return
    if (text.trim() === '') return
    sendingRef.current = true
    setError(null)
    setPhase('sending')
    try {
      const result = await send(text)
      if (result.ok) {
        // 仅当草稿未被并发修改时清空（发送期间用户继续输入的文本保留）。
        setDraft(current => (current === text ? '' : current))
      } else {
        setError(outcomeText(result, fallbackText))
      }
    } catch (error) {
      setError(failureText(error, fallbackText))
    } finally {
      sendingRef.current = false
      setPhase('idle')
    }
  }

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setError(null) // 再次输入即清除上次失败提示（rc.1 toast 同族行为）
    setDraft(event.target.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 发送 / Shift+Enter 换行；IME 组合期 Enter（选词上屏）不发送。
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submitDraft(draft)
  }

  const sendable = stepChatComposerCanSend(draft, phase)

  return (
    <div className={css.root} data-step-chat-composer data-composer-kernel="fallback">
      {/* 批 B2：重试行在输入卡**上方**（需求 1 起 message 为固定默认串——
          面板已无草稿可作载荷，见 StepRetryRow.tsx 头注释）。 */}
      {retry !== undefined && <StepRetryRow port={retry} t={t} />}
      {error !== null && (
        <div className={css.statusError} role="alert" data-composer-status>{error}</div>
      )}
      {phase === 'sending' && error === null && (
        <div className={css.statusInfo} role="status" data-composer-status>
          {t('run.step.chat.composer.sending')}
        </div>
      )}
      <div className={css.card}>
        <textarea
          ref={areaRef}
          className={css.area}
          rows={1}
          value={draft}
          placeholder={placeholderText}
          aria-label={placeholderText}
          data-composer-input
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className={css.row}>
          <span className={css.queueHint} data-composer-queue-hint>
            {t('run.step.chat.composer.queueHint')}
          </span>
          <button
            type="button"
            className={css.send}
            aria-label={sendLabel}
            title={sendLabel}
            disabled={!sendable}
            data-composer-send
            onClick={() => { void submitDraft(draft) }}
          >
            {/* rc.1 InputBar 同款发送箭头（16px viewBox，色随 currentColor）。 */}
            <SendGlyph />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * step 内嵌会话面板的输入框：运行中排队注入；传了 `retry` 端口时在输入卡上方一并渲染
 * 重试行（需求 1 起载荷是固定默认串——面板已无草稿，见 StepRetryRow.tsx 头注释）。
 *
 * **需求 1**：面板不再挂载本组件（见文件头「需求 1」段），以下路径当前只有 spec 驱动；
 * 生产环境的重试行住在 `StepChatPanel` 的底部动作位（`data-step-chat-retry-seat`）。
 *
 * **本批（呈现层统一）**：运行页也**不再**挂载本组件——那里改成 `main-agent-input.tsx` 的
 * 独立输入框（见文件头「运行页不复用本组件」段），故本组件当前没有任何生产挂载点。
 *
 * 内核可用 → KernelComposer（DSH 输入内核 + 自绘壳）；内核缺失 → FallbackComposer
 * （B4b 的 textarea 实现，行为不变）。两条路径的展示条件、文案、发送语义一致，
 * 重试行（retry 端口）也一致。
 */
export function ComposerBar({
  openState, running, send, binding, sessionId, hostSessionId, retry, t,
}: ComposerBarProps) {
  // 内核探测只在 binding 身份变化时重跑（binding 由 StepChatPanel 的 useMemo 稳定）。
  const kernel = useMemo(
    () => resolveStepComposerKernel(binding),
    [binding],
  )

  // 展示条件里的「排队语义」必须在本层订阅：真正的按需渲染在 KernelComposer 内部，
  // 若把队列读取放在那里，队列从非空变空时本层不会重渲（条件永不重算）。
  const queueLength = useSyncExternalStore(
    useCallback(
      listener => (kernel === undefined ? () => undefined : kernel.state.subscribe(listener)),
      [kernel],
    ),
    useCallback(
      () => (kernel === undefined ? 0 : kernel.queueLength()),
      [kernel],
    ),
    useCallback(() => 0, []),
  )

  // 批 B2：重试端口传了就是「待重试的 failed 真实子代理段」（上层已按
  // stepRetryVisible 收窄），它同时是展示条件里的 `retryPending`。
  const retryPending = retry !== undefined
  // 批 B2：宿主原生对话页是否正显示本子代理会话（绑定**前**的根抢占守卫）。
  const hostClaimsRoot = stepComposerHostClaimsRoot(hostSessionId, sessionId)

  // 展示条件：open + （running ∨ 有排队语义 ∨ 待重试）。running 为常态；队列非空时
  // 即使 running 短暂为 false 也保留输入框（刚注入的消息还没被下一轮取走），避免闪没。
  // 第四项（待重试的 failed 段）是批 B2 的放宽，需求 1 后**只对本组件自身生效**：
  // 面板已不挂载本组件（见文件头），该分支在当前版本无生产路径。
  if (!stepChatComposerShown(openState, running, queueLength > 0, retryPending)) return null

  return kernel !== undefined
    ? <KernelComposer kernel={kernel} retry={retry} hostClaimsRoot={hostClaimsRoot} sessionId={sessionId} t={t} />
    : <FallbackComposer send={send} retry={retry} t={t} />
}
