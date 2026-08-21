/**
 * WorkflowList：工作流 overlay 左栏列表（实例/定义 toggle + 搜索 + 新增）。
 *
 * 模式切换与选中态走模块级 `workflow-store`（跨 overlay 开合保留）；内容区复用
 * `InstanceList`（默认态实例，3s 轮询）与 `DefinitionList`（编排态定义）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowList
 */
import { useState, useSyncExternalStore } from 'react'
import {
  Button, IconPlusOutline16, IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

import { InstanceList } from './InstanceList.tsx'
import { DefinitionList } from './DefinitionList.tsx'
import { NewInstanceDialog } from './NewInstanceDialog.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import {
  getWorkflowState, newDefinition, selectDefinition, selectInstance, setWorkflowState, subscribeWorkflowState,
} from './workflow-store.ts'
import css from './WorkflowOverlay.module.css'

/** WorkflowList 接收的 props。 */
export interface WorkflowListProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 工作区成员表（供 InstanceList 按工作区分组）。 */
  workspaces: readonly WorkspaceView[]
  /** 业务 face（列表类 RPC 已解包）。 */
  face: WorkflowOverlayFace
  /** 刷新计数：变化时重挂载列表（保存/删除/手动刷新后）。 */
  refreshKey: number
  /** 列表列宽（px，拖拽分隔条驱动）。 */
  width: number
}

/** 渲染工作流 overlay 左栏列表。 */
export function WorkflowList({ t, workspaces, face, refreshKey, width }: WorkflowListProps) {
  const listMode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listMode)
  const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId)
  const selectedDefinitionId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition?.id)
  const [query, setQuery] = useState('')
  /** 新增实例弹窗开关（实例模式下「+」按钮打开）。 */
  const [creatingInstance, setCreatingInstance] = useState(false)
  /** 实例列表即时刷新计数：新建/删除实例后 +1，重挂载 InstanceList 立即拉取
      （不等 3s 轮询周期，新建后列表立即可见）。 */
  const [instanceTick, setInstanceTick] = useState(0)

  return (
    <section className={css.list} style={{ width }} data-sandore-wf-list>
      <header className={css.listHeader}>
        <div className={css.listTitleRow}>
          <span className={css.listTitle}>{t('panel.title')}</span>
          {/* 实例/编排 开关：胶囊轨道 + 滑块，点击切换激活侧。 */}
          <div className={css.toggle} role="tablist" aria-label={t('list.mode.switch')}>
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
            icon={<IconPlusOutline16 />}
            title={t('panel.add.instance.hint')}
            onClick={() => {
              if (listMode === 'instance') setCreatingInstance(true)
              else newDefinition()
            }}
          >
            {listMode === 'definition' ? t('panel.add.definition') : t('panel.add.instance')}
          </Button>
        </div>
      </header>
      <div className={css.listBody}>
        {listMode === 'definition' ? (
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
          <InstanceList
            key={`inst-${refreshKey}-${instanceTick}`}
            t={t}
            workspaces={workspaces}
            query={query}
            activeId={selectedInstanceId}
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
    </section>
  )
}
