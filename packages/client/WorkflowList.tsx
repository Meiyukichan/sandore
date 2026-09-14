/**
 * WorkflowList：工作流 overlay 左栏列表（实例/定义 toggle + 搜索 + 新增）。
 *
 * 模式切换与选中态走模块级 `workflow-store`（跨 overlay 开合保留）；内容区复用
 * `InstanceList`（默认态实例，3s 轮询）与 `DefinitionList`（编排态定义）。
 * 三级分离（plan §6.1）：编排态下内容区按「工作流 / Microflow 库 / Agent 库」
 * 三分区切换——后两个分区渲染 `LibraryList`（库条目列表），条目点击打开
 * `LibraryEditModal`（YAML 编辑弹窗），「+」按钮直接新建库条目。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowList
 */
import { useState, useSyncExternalStore } from 'react'
import {
  Button, IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

import { InstanceList } from './InstanceList.tsx'
import { DefinitionList } from './DefinitionList.tsx'
import { LibraryList } from './LibraryList.tsx'
import { LibraryEditModal, type LibraryKind } from './LibraryEditModal.tsx'
import { NewInstanceDialog } from './NewInstanceDialog.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import {
  getWorkflowState, newDefinition, selectDefinition, selectInstance, setLibrarySubMode, setWorkflowState,
  subscribeWorkflowState, toggleListCollapse,
} from './workflow-store.ts'
import css from './WorkflowOverlay.module.css'
import panelCss from './WorkflowPanel.module.css'

/** WorkflowList 接收的 props。 */
export interface WorkflowListProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 工作区成员表（供 InstanceList 按工作区分组）。 */
  workspaces: readonly WorkspaceView[]
  /** 业务 face（列表类 RPC 已解包）。 */
  face: WorkflowOverlayFace
  /** 刷新计数：变化时重挂载列表（保存/删除/刷新后）。 */
  refreshKey: number
  /** 列表列宽（px，拖拽分隔条驱动）。 */
  width: number
  /**
   * **宿主会话过滤**（可选；只有主代理会话内的「工作流」tab 传 = 该会话 id）：
   * 实例列表只列绑定到该会话的实例（硬约束：绝不列别的会话的实例）。
   * 侧栏工作流页不传 ⇒ 行为与改动前完全一致。
   */
  hostFilter?: string | undefined
}

/** 编排态三分区 tab 定义（key → store 子模式 + 文案键）。 */
const SUB_MODE_TABS: readonly { key: 'workflow' | 'microflow' | 'agent'; labelKey: 'library.tab.workflow' | 'library.tab.microflow' | 'library.tab.agent' }[] = [
  { key: 'workflow', labelKey: 'library.tab.workflow' },
  { key: 'microflow', labelKey: 'library.tab.microflow' },
  { key: 'agent', labelKey: 'library.tab.agent' },
]

/** 渲染工作流 overlay 左栏列表。 */
export function WorkflowList({ t, workspaces, face, refreshKey, width, hostFilter }: WorkflowListProps) {
  const listMode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listMode)
  const subMode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().librarySubMode)
  const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId)
  const selectedDefinitionId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition?.id)
  const [query, setQuery] = useState('')
  /** 新增实例弹窗开关（实例模式下「+」按钮打开）。 */
  const [creatingInstance, setCreatingInstance] = useState(false)
  /** 实例列表即时刷新计数：新建/删除实例后 +1，重挂载 InstanceList 立即拉取
      （不等 3s 轮询周期，新建后列表立即可见）。 */
  const [instanceTick, setInstanceTick] = useState(0)
  /** 库编辑弹窗目标（kind + entryId；entryId undefined = 新建库条目）。 */
  const [editingEntry, setEditingEntry] = useState<{ kind: LibraryKind; entryId: string | undefined } | undefined>(undefined)
  /** 库编辑保存后的列表刷新计数（重挂载 LibraryList 立即回读）。 */
  const [libraryTick, setLibraryTick] = useState(0)

  /** 库条目删除/保存后的本地刷新：重挂载对应 LibraryList。 */
  const libraryKind = subMode === 'agent' ? 'agent' : 'microflow'
  const listEntries = libraryKind === 'agent' ? face.listSteps : face.listMicroflows
  const deleteEntry = libraryKind === 'agent' ? face.deleteStep : face.deleteMicroflow

  return (
    <section className={css.list} style={{ width }} data-sandore-wf-list>
      <header className={css.listHeader}>
        <div className={css.listTitleRow}>
          <div className={css.listTitleGroup}>
            <span className={css.listTitle}>{t('panel.title')}</span>
            {/* 收起左栏：切换为窄条 rail（展开 + 新增）。 */}
            <button
              type="button"
              className={css.railBtn}
              title={t('list.collapse')}
              aria-label={t('list.collapse')}
              onClick={toggleListCollapse}
            >
              {/* panel-left-close：收起左栏。 */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="m16 15-3-3 3-3" />
              </svg>
            </button>
          </div>
          {/* 实例/编排 开关：胶囊轨道 + 滑块，点击切换激活侧。
              `data-sandore-list-mode-tab` = 稳定 e2e 锚点（两个 WebUI 宿主共用同一份列表头）。 */}
          <div className={css.toggle} role="tablist" aria-label={t('list.mode.switch')} data-sandore-list-mode-tab>
            <span className={`${css.toggleThumb} ${listMode === 'definition' ? css.toggleThumbRight : ''}`} />
            <button
              type="button"
              role="tab"
              aria-selected={listMode === 'instance'}
              className={listMode === 'instance' ? css.toggleActive : ''}
              onClick={() => { setWorkflowState({ listMode: 'instance' }) }}
            >
              {t('list.mode.instance')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={listMode === 'definition'}
              className={listMode === 'definition' ? css.toggleActive : ''}
              onClick={() => { setWorkflowState({ listMode: 'definition' }) }}
            >
              {t('list.mode.definition')}
            </button>
          </div>
        </div>
        <div className={css.listToolbar}>
          <Input
            className={css.search ?? ''}
            icon={<IconSearchOutline16 />}
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder={t('panel.search')}
            aria-label={t('panel.search')}
          />
          <Button
            size="sm"
            variant="primary"
            // 稳定 e2e 锚点：实例模式 = 「运行工作流」；编排/库分区 = 「新增」（加号）。
            data-sandore-list-primary-action={
              listMode === 'instance' ? 'run-workflow' : subMode === 'workflow' ? 'add-definition' : `add-${subMode}`
            }
            // 实例模式 = 运行工作流（播放图标）；编排/库分区保持「新增」（加号）。
            icon={listMode === 'instance' ? <IconPlayOutline16 /> : <IconPlusOutline16 />}
            title={listMode === 'instance'
              ? t('panel.add.instance.hint')
              : subMode === 'workflow' ? t('library.add.workflow')
                : subMode === 'agent' ? t('library.add.agent') : t('library.add.microflow')}
            onClick={() => {
              if (listMode === 'instance') setCreatingInstance(true)
              else if (subMode === 'workflow') newDefinition()
              else setEditingEntry({ kind: libraryKind, entryId: undefined })
            }}
          >
            {listMode === 'instance'
              ? t('panel.add.instance')
              : subMode === 'workflow' ? t('library.add.workflow')
                : subMode === 'agent' ? t('library.add.agent') : t('library.add.microflow')}
          </Button>
        </div>
        {/* 编排态三分区（三级分离 plan §6.1）：工作流 / Microflow 库 / Agent 库。 */}
        {listMode === 'definition' && (
          <div className={css.subModeTabs} role="tablist" aria-label={t('library.submode.switch')}>
            {SUB_MODE_TABS.map(tab => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={subMode === tab.key}
                className={subMode === tab.key ? css.subModeTabActive : css.subModeTab}
                onClick={() => { setLibrarySubMode(tab.key) }}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className={css.listBody}>
        {listMode === 'definition' ? (
          subMode === 'workflow' ? (
            <DefinitionList
              key={`def-${refreshKey}`}
              t={t}
              query={query}
              activeId={selectedDefinitionId}
              listDefinitions={face.listDefinitions}
              deleteDefinition={face.deleteDefinition}
              onOpen={selectDefinition}
            />
          ) : (
            <div className={panelCss.body}>
              <LibraryList
                key={`lib-${libraryKind}-${refreshKey}-${libraryTick}`}
                t={t}
                kind={libraryKind}
                query={query}
                listEntries={listEntries}
                deleteEntry={deleteEntry}
                onOpen={entryId => { setEditingEntry({ kind: libraryKind, entryId }) }}
              />
            </div>
          )
        ) : (
          <InstanceList
            key={`inst-${refreshKey}-${instanceTick}`}
            t={t}
            workspaces={workspaces}
            query={query}
            activeId={selectedInstanceId}
            {...(hostFilter === undefined ? {} : { hostFilter })}
            listInstances={face.listInstances}
            deleteInstance={face.deleteInstance}
            onOpen={selectInstance}
            onInstanceDeleted={() => { setInstanceTick(tick => tick + 1) }}
          />
        )}
      </div>
      {creatingInstance && (
        <NewInstanceDialog
          t={t}
          face={face}
          onClose={() => { setCreatingInstance(false) }}
          onCreated={instanceId => {
            setCreatingInstance(false)
            selectInstance(instanceId)
            // 立即重挂载实例列表，让新实例马上可见（不必等轮询周期）。
            setInstanceTick(tick => tick + 1)
          }}
        />
      )}
      {editingEntry !== undefined && (
        <LibraryEditModal
          t={t}
          kind={editingEntry.kind}
          entryId={editingEntry.entryId}
          face={face}
          onClose={() => { setEditingEntry(undefined) }}
          onSaved={() => {
            setEditingEntry(undefined)
            setLibraryTick(tick => tick + 1)
          }}
        />
      )}
    </section>
  )
}
