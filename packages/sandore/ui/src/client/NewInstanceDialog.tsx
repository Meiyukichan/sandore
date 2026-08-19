/**
 * NewInstanceDialog：新增工作流实例弹窗（去 job 概念：直接绑定定义启动）。
 *
 * 字段（自上而下，照用户要求顺序）：
 * 1. 工作目录 —— DSH 原生目录选择器（`face.pickDirectory`，读路径后内联显示，可重选）。
 * 2. 作业需求 —— 多行文本输入（textarea，可换行）。
 * 3. 绑定工作流 —— 下拉选择已保存的定义（`face.listDefinitions`）。
 * 4. 模型 —— 照对话输入框的模型下拉（provider 分组 + 模型项，`face.listModelDirectory`）。
 * 5. 权限策略 —— 照对话输入框的权限下拉（read-only / workspace-write / danger-full-access
 *    三个预设，本地选中；`danger-full-access` 需风险确认）。
 * 确定 → `face.startInstance({ workflowId, originalInput, cwd?, model?, permission? })`，
 * 成功后 `onCreated(run.instanceId)`（宿主切执行态并选中）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/NewInstanceDialog
 */
import { useEffect, useRef, useState } from 'react'
import {
  Button, IconBrowseOutline16, IconCheckOutline16, IconChevronDownOutline14, IconCloseOutline16,
  IconFolderOpenOutline16, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { ModelDirectoryEntry, StartInstanceParams, WorkflowOverlayFace } from './workflow-face.ts'
import { describeError } from './describe-error.ts'
import css from './NewInstanceDialog.module.css'
import selectCss from './composer-selects.module.css'

/** 权限预设机器值 → 展示名（照 DSH PermissionSelect）。 */
const PERMISSION_OPTIONS: readonly { value: string; name: string }[] = [
  { value: 'read-only', name: 'Read only' },
  { value: 'workspace-write', name: 'Workspace write' },
  { value: 'danger-full-access', name: 'Full access' },
]

/** 模型菜单加载状态。 */
type ModelsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly directory: readonly ModelDirectoryEntry[] }

/** NewInstanceDialog 接收的 props。 */
export interface NewInstanceDialogProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 业务 face（RPC 已解包）。 */
  face: WorkflowOverlayFace
  /** 关闭弹窗。 */
  onClose(): void
  /** 创建成功回调（携带实例 id，供宿主切执行态并选中）。 */
  onCreated(instanceId: string): void
}

/** 权限触发器 glyph（read-only=对勾 / workspace-write=铅笔 / full-access=感叹）。 */
function permissionGlyph(value: string) {
  switch (value) {
    case 'read-only':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
          <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        </svg>
      )
    case 'danger-full-access':
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
          <path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
          <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
          <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
          <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
          <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
        </svg>
      )
  }
}

/** 渲染「新增实例」弹窗。 */
export function NewInstanceDialog({ t, face, onClose, onCreated }: NewInstanceDialogProps) {
  // 表单字段：工作目录 / 作业需求 / 绑定工作流 / 模型 / 权限。
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [requirement, setRequirement] = useState('')
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState<StartInstanceParams['model']>(undefined)
  // 权限默认 workspace-write（与触发器显示一致；提交时始终携带，引擎据此应用沙箱/审批）。
  const [permission, setPermission] = useState<string>('workspace-write')

  // 数据源：定义下拉 + 模型目录 + 提交状态。
  const [definitions, setDefinitions] = useState<{ id: string; name: string }[] | undefined>(undefined)
  const [models, setModels] = useState<ModelsState>({ kind: 'loading' })
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  // 下拉开合：绑定工作流 / 模型 / 权限。
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<string | undefined>(undefined)

  const rootRef = useRef<HTMLDivElement | null>(null)

  // 挂载时拉取定义列表与模型目录（失败内联呈现，不阻断表单）。
  useEffect(() => {
    let alive = true
    void face.listDefinitions().then(
      entries => { if (alive) setDefinitions(entries.map(entry => ({ id: entry.id, name: entry.name }))) },
      (error: unknown) => { if (alive) setErrorMessage(describeError(error)) },
    )
    void face.listModelDirectory().then(
      directory => { if (alive) setModels({ kind: 'ready', directory }) },
      (error: unknown) => { if (alive) setModels({ kind: 'error', message: describeError(error) }) },
    )
    return () => { alive = false }
  }, [face])

  // 点击外部关闭所有下拉。
  useEffect(() => {
    if (!workflowOpen && !modelOpen && !permissionOpen) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setWorkflowOpen(false)
        setModelOpen(false)
        setPermissionOpen(false)
      }
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [workflowOpen, modelOpen, permissionOpen])

  const selectedDefinition = definitions?.find(entry => entry.id === workflowId)
  const selectedModel = model === undefined
    ? undefined
    : models.kind === 'ready'
      ? models.directory.flatMap(provider => provider.models.map(m => ({ provider, m })))
          .find(entry => entry.provider.provider === model?.provider && entry.m.id === model.model)
      : undefined
  const modelLabel = selectedModel === undefined
    ? t('composer.model.fallback')
    : selectedModel.m.name

  const canSubmit = submitting === false && workflowId !== undefined && requirement.trim() !== ''

  /** 打开 DSH 原生目录选择器，选中后回填（取消保持原值）。 */
  const browse = async (): Promise<void> => {
    try {
      const picked = await face.pickDirectory()
      if (picked !== undefined) setCwd(picked)
    } catch (error) {
      setErrorMessage(describeError(error))
    }
  }

  /** 确定：收集全部参数创建实例。 */
  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setErrorMessage(undefined)
    try {
      const input: StartInstanceParams = {
        workflowId,
        originalInput: requirement,
        ...(cwd === undefined ? {} : { cwd }),
        ...(model === undefined ? {} : { model }),
        ...(permission === undefined ? {} : { permission }),
      }
      const run = await face.startInstance(input)
      onCreated(run.instanceId)
    } catch (error) {
      setErrorMessage(describeError(error))
      setSubmitting(false)
    }
  }

  const choosePermission = (value: string): void => {
    setPermissionOpen(false)
    if (value === 'danger-full-access') {
      setAcknowledged(false)
      setFullAccessConfirm(true)
      return
    }
    setPermission(value)
  }

  const confirmFullAccess = (): void => {
    if (!acknowledged) return
    setFullAccessConfirm(false)
    setPermission('danger-full-access')
  }

  return (
    <Modal
      open
      className={`${css.dialog}`}
      onClose={() => { if (!submitting) onClose() }}
      title={t('instance.create.title')}
      closeLabel={t('instance.create.cancel')}
      headless
    >
      {/* 自持头部：标题 + 关闭按钮（Modal headless 只留 mask/卡片/Escape；
          间距自控，标题到表单不留 DSH 默认 20px body 上边距）。 */}
      <div className={css.card}>
        <div className={css.cardHeader}>
          <h2 className={css.cardTitle}>{t('instance.create.title')}</h2>
          <button type="button" className={css.cardClose} aria-label={t('instance.create.cancel')} onClick={() => { if (!submitting) onClose() }}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div className={css.form} ref={rootRef}>
        {/* 1. 工作目录：DSH 原生目录选择器（只读路径 + 浏览按钮）。 */}
        <label className={css.field}>
          <span className={css.label}>{t('instance.create.cwd')}</span>
          <div className={css.cwdRow}>
            <Input
              className={`${css.cwdInput}`}
              icon={<IconFolderOpenOutline16 />}
              value={cwd ?? t('instance.create.cwd.placeholder')}
              readOnly
              title={cwd}
            />
            <Button size="sm" variant="outline" className={`${css.browseBtn}`} icon={<IconBrowseOutline16 />} onClick={() => { void browse() }}>
              {t('instance.create.browse')}
            </Button>
          </div>
        </label>

        {/* 2. 作业需求：多行文本输入。 */}
        <label className={css.field}>
          <span className={css.label}>{t('instance.create.requirement')}</span>
          <textarea
            className={css.textarea}
            value={requirement}
            onChange={event => { setRequirement(event.target.value) }}
            placeholder={t('instance.create.requirement.placeholder')}
            rows={4}
            disabled={submitting}
          />
        </label>

        {/* 3. 绑定工作流：下拉选择已保存的定义。 */}
        <label className={css.field}>
          <span className={css.label}>{t('instance.create.workflow')}</span>
          <div className={`${selectCss.msRoot} ${css.selectRoot}`}>
            <button
              type="button"
              className={css.selectTrigger}
              aria-haspopup="menu"
              aria-expanded={workflowOpen}
              disabled={definitions === undefined || submitting}
              onClick={() => { setWorkflowOpen(current => !current) }}
            >
              <span className={css.selectTriggerLabel}>
                {selectedDefinition?.name ?? t('instance.create.workflow.placeholder')}
              </span>
              <span className={`${css.selectChevron} ${workflowOpen ? css.selectChevronOpen : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
            </button>
            {workflowOpen && (
              <div className={css.dialogMenu} role="menu" aria-label={t('instance.create.workflow')}>
                {definitions === undefined
                  ? <div className={selectCss.status}>{t('panel.loading')}</div>
                  : definitions.length === 0
                    ? <div className={selectCss.empty}>{t('instance.create.workflow.empty')}</div>
                    : definitions.map(entry => {
                      const selected = entry.id === workflowId
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={`${selectCss.option} ${selected ? selectCss.selected : ''}`}
                          key={entry.id}
                          onClick={() => { setWorkflowId(entry.id); setWorkflowOpen(false) }}
                        >
                          <span className={selectCss.optionCopy}>
                            <span className={selectCss.modelName}>{entry.name}</span>
                          </span>
                          <span className={selectCss.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                        </button>
                      )
                    })}
              </div>
            )}
          </div>
        </label>

        {/* 4. 模型：照对话输入框模型下拉（provider 分组 + 模型项）。 */}
        <label className={css.field}>
          <span className={css.label}>{t('instance.create.model')}</span>
          <div className={`${selectCss.msRoot} ${css.selectRoot}`}>
            <button
              type="button"
              className={css.selectTrigger}
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              disabled={models.kind !== 'ready' || submitting}
              onClick={() => { setModelOpen(current => !current) }}
            >
              <span className={css.selectTriggerLabel}>{modelLabel}</span>
              <span className={`${css.selectChevron} ${modelOpen ? css.selectChevronOpen : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
            </button>
            {modelOpen && (
              <div className={css.dialogMenu} role="menu" aria-label={t('instance.create.model')}>
                {models.kind === 'loading' && <div className={selectCss.status}>{t('composer.model.loading')}</div>}
                {models.kind === 'error' && (
                  <div className={selectCss.error}>
                    <span>{t('composer.model.error', { message: models.message })}</span>
                    <button
                      type="button"
                      className={selectCss.retry}
                      onClick={() => {
                        setModels({ kind: 'loading' })
                        void face.listModelDirectory().then(
                          directory => { setModels({ kind: 'ready', directory }) },
                          (error: unknown) => { setModels({ kind: 'error', message: describeError(error) }) },
                        )
                      }}
                    >
                      {t('composer.model.reload')}
                    </button>
                  </div>
                )}
                {models.kind === 'ready' && (
                  <div className={selectCss.groups}>
                    {models.directory.map(provider => (
                      <section role="group" aria-label={provider.providerName} className={selectCss.group} key={provider.provider}>
                        <div className={selectCss.groupTitle}>{provider.providerName}</div>
                        {provider.models.map(entry => {
                          const selected = model?.provider === provider.provider && model.model === entry.id
                          return (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              className={`${selectCss.option} ${selected ? selectCss.selected : ''}`}
                              key={entry.id}
                              title={entry.name}
                              onClick={() => {
                                setModel({ provider: provider.provider, model: entry.id })
                                setModelOpen(false)
                              }}
                            >
                              <span className={selectCss.optionCopy}>
                                <span className={selectCss.modelName}>{entry.name}</span>
                              </span>
                              <span className={selectCss.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                            </button>
                          )
                        })}
                      </section>
                    ))}
                    {models.directory.length === 0 && (
                      <div className={selectCss.empty}>{t('composer.model.empty')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </label>

        {/* 5. 权限策略：read-only / workspace-write / danger-full-access 三个预设。 */}
        <label className={css.field}>
          <span className={css.label}>{t('instance.create.permission')}</span>
          <div className={`${selectCss.msRoot} ${css.selectRoot}`}>
            <button
              type="button"
              className={css.selectTrigger}
              aria-haspopup="menu"
              aria-expanded={permissionOpen}
              disabled={submitting}
              onClick={() => { setPermissionOpen(current => !current) }}
            >
              <span className={css.selectTriggerIcon} aria-hidden>{permissionGlyph(permission ?? 'workspace-write')}</span>
              <span className={css.selectTriggerLabel}>
                {permission === undefined
                  ? t('instance.create.permission.default')
                  : permission === 'danger-full-access'
                    ? 'Full access'
                    : permission === 'read-only'
                      ? 'Read only'
                      : 'Workspace write'}
              </span>
              <span className={`${css.selectChevron} ${permissionOpen ? css.selectChevronOpen : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
            </button>
            {permissionOpen && (
              <div className={css.dialogMenu} role="menu" aria-label={t('instance.create.permission')}>
                {PERMISSION_OPTIONS.map(option => {
                  const selected = (permission ?? 'workspace-write') === option.value
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`${selectCss.option} ${selected ? selectCss.selected : ''}`}
                      key={option.value}
                      onClick={() => { choosePermission(option.value) }}
                    >
                      <span className={selectCss.optionIcon} aria-hidden>{permissionGlyph(option.value)}</span>
                      <span className={selectCss.optionCopy}>
                        <span className={selectCss.modelName}>{option.name}</span>
                      </span>
                      <span className={selectCss.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </label>

        {errorMessage !== undefined && (
          <p className={css.error} role="alert">{t('panel.error', { message: errorMessage })}</p>
        )}
        </div>

        {/* 自持底部：取消 / 创建（headless 下 Modal 不再渲染 footer）。 */}
        <div className={css.cardFooter}>
          <Button variant="ghost" size="sm" disabled={submitting} onClick={onClose}>{t('instance.create.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => { void submit() }}>
            {submitting ? t('instance.create.submitting') : t('instance.create.submit')}
          </Button>
        </div>
      </div>

      {/* 完全访问风险确认（照 DSH RiskConfirmation 卡片）。 */}
      {fullAccessConfirm && (
        <div className={selectCss.riskMask}>
          <div className={selectCss.riskCard} role="alertdialog" aria-modal="true">
            <div className={selectCss.riskTitle}>{t('composer.permission.confirmTitle')}</div>
            <div className={selectCss.riskDesc}>{t('composer.permission.confirmDesc')}</div>
            <label className={selectCss.riskAck}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={event => { setAcknowledged(event.target.checked) }}
              />
              <span>{t('composer.permission.acknowledge')}</span>
            </label>
            <div className={selectCss.riskActions}>
              <button
                type="button"
                className={selectCss.riskCancel}
                onClick={() => { setFullAccessConfirm(false); setAcknowledged(false) }}
              >
                {t('composer.permission.cancel')}
              </button>
              <button
                type="button"
                className={selectCss.riskConfirm}
                disabled={!acknowledged}
                onClick={confirmFullAccess}
              >
                {t('composer.permission.enable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
