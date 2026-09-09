/**
 * ComposerSelects：执行详情输入框的两个选择器（模型 / 权限）。
 *
 * 行为与 DSH web 主 session 完全一致：
 * - 模型：`modelDirectory`（复用 DSH `ctx.modelDirectories` 的 per-session 目录）
 *   点击 → 两级菜单（模型 / 推理等级）→ 选择经 `select` → `selectModel` 绑定到
 *   当前实例会话（instanceId）；触发器显示当前模型 + 推理等级。
 * - 权限：从会话 `projections.permissions` 读权限投影，点击 → 菜单列出预设
 *   （read-only / workspace-write / danger-full-access）→ 选择后经 `runCommand`
 *   执行 `/permission <id>`（与主 session 同一命令路径）；`danger-full-access`
 *   先弹风险确认。触发器显示当前权限名 + 盾牌图标。
 * 样式照 DSH ModelSelect.module.css / PermissionSelect.module.css。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/composer-selects
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type {
  ModelDirectoryFace, ModelSelection, PermissionSelectValue,
} from './model-faces.ts'
import css from './composer-selects.module.css'

/** 完整访问权限预设值（与 DSH PermissionSelect 的 FULL_ACCESS 一致）。 */
const FULL_ACCESS = 'danger-full-access'

/** 权限投影与命令查询均不可用时的降级占位（显示但锁定；仅旧日志实例触发）。 */
const FALLBACK_PERMISSION: PermissionSelectValue = {
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: FULL_ACCESS, name: FULL_ACCESS },
  ],
  currentValue: 'workspace-write',
}

// ── 模型选择（照 DSH ui-model-selection ModelSelect） ──────────────────────

type Pane = 'root' | 'model' | 'effort'

interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** 渲染模型触发器 + 两级菜单（复用 DSH 的模型目录数据面）。 */
export function ModelSelectSandore({ t, directory, locked }: {
  readonly t: TranslateNS<'sandore'>
  readonly directory: ModelDirectoryFace
  readonly locked: boolean
}) {
  const state = useSyncExternalStore(
    fn => directory.store.subscribe(fn),
    () => directory.store.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastActionRef = useRef<'load' | 'select'>('load')

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('composer.model.effortDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('composer.model.effortDefault') }]
        : [],
      ...reasoning.efforts.map(level => ({
        key: `effort:${level.id}`,
        effort: level.id,
        label: level.name,
        ...level.description === undefined ? {} : { description: level.description },
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    void directory.load().catch(() => { /* 错误上屏 */ })
  }

  useEffect(() => {
    if (locked) {
      setOpen(false)
      return
    }
    if (!locked) {
      lastActionRef.current = 'load'
      void directory.load().catch(() => { /* 错误上屏 */ })
    }
  }, [locked, directory])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (state.routable === false) return null

  const show = (): void => {
    setPane('root')
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { rootRef.current?.querySelector('button')?.focus() })
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      close(true)
      return
    }
    const message = directory.store.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('composer.model.error', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void directory.select(selection).then(
      () => { settleSelection(true) },
      () => { settleSelection(false) },
    )
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void directory.select(selection).then(
      () => { settleSelection(true) },
      () => { settleSelection(false) },
    )
  }

  const modelLabel = currentChoice?.model.name ?? t('composer.model.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('composer.model.fallback')
    : effortLabel === undefined
      ? t('composer.model.aria', { model: modelLabel })
      : t('composer.model.ariaEffort', { model: modelLabel, effort: effortLabel })

  return (
    <div ref={rootRef} className={css.msRoot}>
      <button
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        disabled={locked}
        onClick={() => { if (open) { close() } else { show() } }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
      </button>

      {open && (
        <div className={css.menu} role="menu" aria-label={t('composer.model.menu')} aria-busy={state.status === 'loading' || busy}>
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
                <span className={css.cellLabel}>{t('composer.model.title')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <span className={css.cellChevron} aria-hidden><IconChevronRightOutline14 /></span>
              </button>
              {reasoning !== undefined && (
                <button type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
                  <span className={css.cellLabel}>{t('composer.model.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <span className={css.cellChevron} aria-hidden><IconChevronRightOutline14 /></span>
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {state.status === 'loading' && <div className={css.status}>{t('composer.model.loading')}</div>}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('composer.model.error', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('composer.model.reload')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('composer.model.warning', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('composer.model.reload')}</button>
                </div>
              ))}
              <div className={css.groups}>
                {state.groups.map(group => (
                  <section role="group" aria-label={group.name} className={css.group} key={group.id}>
                    <div className={css.groupTitle}>{group.name}</div>
                    {group.models.map(model => {
                      const selected = state.current?.provider === group.id && state.current.model === model.id
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={`${css.option} ${selected ? css.selected : ''}`}
                          key={model.id}
                          title={model.name}
                          disabled={busy}
                          onClick={() => { choose({ provider: group.id, model: model.id }) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                            {model.description !== undefined && (
                              <span className={css.description}>{model.description}</span>
                            )}
                          </span>
                          <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                        </button>
                      )
                    })}
                  </section>
                ))}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('composer.model.empty')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('composer.model.emptyEfforts')}</div>
                : effortChoices.map(level => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={`${css.option} ${effectiveEffort === level.effort ? css.selected : ''}`}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                      {level.description !== undefined && (
                        <span className={css.description}>{level.description}</span>
                      )}
                    </span>
                    <span className={css.check}>{effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}</span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}

      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}

// ── 权限选择（照 DSH ui-conversation PermissionSelect） ────────────────────

/** 权限盾牌 glyph（照 DSH PermissionSelect 的 3 种：对勾 / 铅笔 / 感叹）。 */
function permissionGlyph(value: string) {
  switch (value) {
    case 'read-only':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
          <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        </svg>
      )
    case FULL_ACCESS:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
          <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
          <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
        </svg>
      )
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z" fill="currentColor" />
          <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
          <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
          <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
          <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
        </svg>
      )
  }
}

/** 机器名 → 展示名（`workspace-write` → `Workspace Write`）。 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** 渲染权限触发器 + 菜单 + 完全访问确认（行为照 DSH PermissionSelect）。 */
export function PermissionSelectSandore({ t, value, locked, runCommand, queryValue }: {
  readonly t: TranslateNS<'sandore'>
  readonly value: PermissionSelectValue | undefined
  readonly locked: boolean
  readonly runCommand: (line: string) => Promise<boolean>
  /** 权限投影缺失时的回退查询（`/permission` 无参报告）。 */
  readonly queryValue: () => Promise<PermissionSelectValue | undefined>
}) {
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pendingPick, setPendingPick] = useState(false)
  const [fallback, setFallback] = useState<PermissionSelectValue | undefined>(undefined)
  const [fallbackFailed, setFallbackFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // queryValue 经 ref 读取：宿主 prop 常为内联箭头（每次渲染新引用），若进 effect
  // 依赖会「渲染 → 查询 → setFallback(新对象) → 渲染」风暴（React #185）。ref 让
  // effect 只随投影值（value）变化而重查。
  const queryValueRef = useRef(queryValue)
  queryValueRef.current = queryValue

  // 投影缺失 → 命令查询回退（会话未被 DSH 打开过时投影为空）；查询失败（如
  // 旧日志实例无法 resume）降级为占位并锁定，保证选择器不消失。
  useEffect(() => {
    if (value !== undefined) {
      setFallback(undefined)
      setFallbackFailed(false)
      return
    }
    let alive = true
    void queryValueRef.current().then(next => {
      if (!alive) return
      if (next === undefined) setFallbackFailed(true)
      else setFallback(next)
    })
    return () => { alive = false }
  }, [value])

  useEffect(() => {
    if (!locked && (value ?? fallback) !== undefined) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(false)
  }, [locked, value, fallback])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // 投影 → 查询回退 → 降级占位（锁定）。
  const degraded = value === undefined && fallback === undefined && fallbackFailed
  const effective = value ?? fallback ?? (degraded ? FALLBACK_PERMISSION : undefined)
  const lockedOrDegraded = locked || degraded
  if (effective === undefined) return null

  const currentValue = effective.currentValue
  const current = effective.options.find(option => option.value === currentValue)
  const busy = pendingPick

  const submit = (id: string): void => {
    setPendingPick(true)
    void runCommand(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPendingPick(false) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === currentValue) return
    if (id === FULL_ACCESS) {
      setAcknowledged(false)
      setConfirmation(true)
      return
    }
    submit(id)
  }

  const confirmFullAccess = (): void => {
    if (lockedOrDegraded || !acknowledged || !confirmation) return
    setConfirmation(false)
    submit(FULL_ACCESS)
  }

  const glyph = permissionGlyph(currentValue)
  return (
    <div ref={rootRef} className={css.msRoot}>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('run.permission.title')}
        title={current?.description}
        disabled={lockedOrDegraded || busy}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.triggerIcon} aria-hidden>{glyph}</span>
        <span className={css.triggerLabel}>
          {current === undefined
            ? displayName(currentValue)
            : current.value === FULL_ACCESS
              ? 'Full access'
              : displayName(current.name)}
        </span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
      </button>

      {open && (
        <div className={css.menu} role="menu" aria-label={t('run.permission.title')}>
          {effective.options
            .filter(option => option.value !== 'custom')
            .map(option => {
              const selected = option.value === currentValue
              const icon = permissionGlyph(option.value)
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`${css.option} ${selected ? css.selected : ''}`}
                  key={option.value}
                  disabled={busy}
                  onClick={() => { choose(option.value) }}
                >
                  <span className={css.optionIcon} aria-hidden>{icon}</span>
                  <span className={css.optionCopy}>
                    <span className={css.modelName}>
                      {option.value === FULL_ACCESS ? 'Full access' : displayName(option.name)}
                    </span>
                  </span>
                  <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                </button>
              )
            })}
        </div>
      )}

      {confirmation && (
        <div className={css.riskMask}>
          <div className={css.riskCard} role="alertdialog" aria-modal="true">
            <div className={css.riskTitle}>{t('composer.permission.confirmTitle')}</div>
            <div className={css.riskDesc}>{t('composer.permission.confirmDesc')}</div>
            <label className={css.riskAck}>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={lockedOrDegraded}
                onChange={event => { setAcknowledged(event.target.checked) }}
              />
              <span>{t('composer.permission.acknowledge')}</span>
            </label>
            <div className={css.riskActions}>
              <button
                type="button"
                className={css.riskCancel}
                onClick={() => { setConfirmation(false); setAcknowledged(false) }}
              >
                {t('composer.permission.cancel')}
              </button>
              <button
                type="button"
                className={css.riskConfirm}
                disabled={!acknowledged || lockedOrDegraded}
                onClick={confirmFullAccess}
              >
                {t('composer.permission.enable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
