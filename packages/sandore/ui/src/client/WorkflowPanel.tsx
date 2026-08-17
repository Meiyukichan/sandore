/**
 * WorkflowPanel：工作流展开面板（header 搜索/编排/新增 + 两级下钻 view 栈 + 宽展开）。
 *
 * 由 WorkflowButton 承载，以 `.panel` fixed 浮层弹出（宽展开 layer，不受 rail 宽度
 * 约束）。header 在列表态提供搜索（客户端过滤）、编排 toggle（默认态↔编排态）与
 * 新增按钮（编排态新增定义；默认态「新增实例」暂未实现，按钮禁用并以 tooltip 说明
 * 需先创建定义/Job）；下钻态仅保留返回按钮。内部维护
 * view 状态栈（`list` ↔ `editor`/DagEditor ↔ `run`/RunView，经 `viewStackReducer`），
 * 编排 toggle / 搜索关键词存于面板自身 state，下钻返回后自然保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowPanel
 */
import { useReducer, useState } from 'react'
import {
  Button, IconChevronLeftOutline14, IconPlusOutline16, IconSearchOutline16, Input, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'

import { DagEditor } from './DagEditor.tsx'
import { RunView } from './RunView.tsx'
import type { RunViewRemote } from './RunView.tsx'
import { InstanceList } from './InstanceList.tsx'
import { DefinitionList } from './DefinitionList.tsx'
import { INITIAL_VIEW_STACK, topView, viewStackReducer } from './view-stack.ts'
import type { SaveDefinition } from './sandore-save.ts'
import type { OpenDiscussion } from './open-discussion.ts'
import css from './WorkflowPanel.module.css'

/** WorkflowPanel 接收的普通业务 props（由 WorkflowButton 从 slot face 与 owner 组装）。 */
export interface WorkflowPanelProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 工作区成员表（供 InstanceList 按工作区分组）。 */
  workspaces: readonly WorkspaceView[]
  /** 拉取实例摘要（RPC 已解包）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** 拉取定义列表（RPC 已解包）。 */
  listDefinitions(): Promise<WorkflowDefinitionEntry[]>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /** DagEditor 保存回调（由 createSandoreSave 产出）。 */
  save: SaveDefinition
  /** 按 instanceId 生成 RunView 的「打开讨论」回调（由 createOpenDiscussion 产出）。 */
  openDiscussion(instanceId: string): OpenDiscussion
  /** RunView 所需的最小 RPC 访问面。 */
  remote: RunViewRemote
}

/** 渲染 WorkflowPanel。 */
export function WorkflowPanel({ t, workspaces, listInstances, listDefinitions, deleteDefinition, save, openDiscussion, remote }: WorkflowPanelProps) {
  const [viewStack, dispatch] = useReducer(viewStackReducer, INITIAL_VIEW_STACK)
  const [orchestrating, setOrchestrating] = useState(false)
  const [query, setQuery] = useState('')

  const current = topView(viewStack)
  const drilled = current.kind !== 'list'

  const handleBack = (): void => { dispatch({ type: 'back' }) }

  const handleAdd = (): void => {
    // 仅编排态可达（默认态「新增实例」按钮已禁用）：下钻空白 DagEditor，
    // 无 initialId/initialYaml，首次保存走 createDefinition。
    dispatch({ type: 'open', view: { kind: 'editor' } })
  }

  return (
    <section
      className={drilled ? `${css.panel} ${css.drill}` : css.panel}
      aria-label={t('panel.title')}
      data-sandore-panel
    >
      <header className={css.header}>
        {drilled ? (
          <Button size="sm" variant="ghost" icon={<IconChevronLeftOutline14 />} onClick={handleBack}>
            {t('panel.back')}
          </Button>
        ) : (
          <>
            <span className={css.title}>{t('panel.title')}</span>
            <Input
              className={css.search ?? ''}
              icon={<IconSearchOutline16 />}
              value={query}
              onChange={event => { setQuery(event.target.value) }}
              placeholder={t('panel.search')}
              aria-label={t('panel.search')}
            />
            <Pill active={orchestrating} onClick={() => { setOrchestrating(value => !value) }}>
              {t('panel.orchestrate')}
            </Pill>
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutline16 />}
              disabled={!orchestrating}
              title={orchestrating ? undefined : t('panel.add.instance.hint')}
              onClick={handleAdd}
            >
              {orchestrating ? t('panel.add.definition') : t('panel.add.instance')}
            </Button>
          </>
        )}
      </header>

      {drilled ? (
        <div className={css.drillBody}>
          {current.kind === 'editor' ? (
            <DagEditor t={t} initialId={current.definitionId} initialYaml={current.initialYaml} save={save} />
          ) : (
            <RunView t={t} instanceId={current.instanceId} openDiscussion={openDiscussion(current.instanceId)} remote={remote} />
          )}
        </div>
      ) : (
        <div className={css.body}>
          {orchestrating ? (
            <DefinitionList
              t={t}
              query={query}
              listDefinitions={listDefinitions}
              deleteDefinition={deleteDefinition}
              onOpen={(definitionId, initialYaml) => {
                dispatch({ type: 'open', view: { kind: 'editor', definitionId, initialYaml } })
              }}
            />
          ) : (
            <InstanceList
              t={t}
              workspaces={workspaces}
              query={query}
              listInstances={listInstances}
              onOpen={instanceId => { dispatch({ type: 'open', view: { kind: 'run', instanceId } }) }}
            />
          )}
        </div>
      )}
    </section>
  )
}
