/**
 * WorkflowView：conversation.view「工作流」tab 主体 —— VSCode 式双栏工作区。
 *
 * 左侧为工作流列表侧边栏（默认态实例列表 / 编排态定义列表，搜索 + toggle + 新增），
 * 右侧为编辑区：选择实例渲染 RunView（执行详情），选择定义渲染 DagEditor（编排器），
 * 未选择渲染占位提示。根节点带 `data-conversation-composer-overlay`（对齐
 * ui-trajectory）：composer 悬浮于底部预留条之上，工作区占满主区其余高度。
 * 选中态放在模块级 snapshot store（`createSnapshotStore`），跨会话/视图切换保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowView
 */
import { useEffect, useSyncExternalStore, useState, type ReactNode } from 'react'
import {
  Button, IconPlusOutline16, IconSearchOutline16, Input, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GlobalStandardProps, InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'

import { InstanceList } from './InstanceList.tsx'
import { DefinitionList } from './DefinitionList.tsx'
import { DagEditor } from './DagEditor.tsx'
import { RunView, type RunViewRemote } from './RunView.tsx'
import type { SaveDefinition } from './sandore-save.ts'
import { describeError } from './describe-error.ts'
import css from './WorkflowView.module.css'

/** 编辑区打开目标：实例（RunView）或定义（DagEditor；id 省略为新建）。 */
export type WorkflowSelection =
  | { readonly kind: 'instance'; readonly id: string }
  | { readonly kind: 'definition'; readonly id?: string; readonly initialYaml?: string }

/**
 * 模块级选中态：跨会话/视图切换保留（避免每次打开 tab 重置）。
 * 自实现 getSnapshot/subscribe（DSH bundle 的 ModuleLoader 格式无法被 bundler
 * 静态分析出 `createSnapshotStore` 具名导出，故不依赖 dsh-client-runtime）。
 */
let selection: WorkflowSelection | null = null
const selectionListeners = new Set<() => void>()

function getSelection(): WorkflowSelection | null {
  return selection
}

function setSelection(next: WorkflowSelection | null): void {
  selection = next
  for (const listener of selectionListeners) listener()
}

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener)
  return () => { selectionListeners.delete(listener) }
}

/** WorkflowView 接收的业务 face（RPC 已解包；`useWorkspaces` 为全局标准 prop）。 */
export interface WorkflowViewFace {
  /** 拉取实例摘要（RPC 已解包）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** 拉取定义列表（RPC 已解包）。 */
  listDefinitions(): Promise<WorkflowDefinitionEntry[]>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /** 读取定义原始 YAML（RPC 已解包）。 */
  getYaml(id: string): Promise<string>
  /** DagEditor 保存回调（`createSandoreSave` 接线）。 */
  save: SaveDefinition
  /** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
  remote: RunViewRemote
  /** 打开宿主会话（RunView「打开讨论」跳实例会话）。 */
  openSession(id: string): void
}

/** WorkflowView 的组件 props：注入 face + locale + 全局标准 prop（useWorkspaces）。 */
export type WorkflowViewProps =
  InjectFace<WorkflowViewFace> & PropsLocale<'sandore'> & GlobalStandardProps

/** 定义编辑器加载态（仅当选中态缺失 initialYaml 时按需拉取）。 */
type DefinitionLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly yaml: string }

/** 定义加载壳：拉取 YAML 后渲染 DagEditor（id 变化时重拉并重挂载）。 */
function DefinitionLoader({ t, definitionId, getYaml, save, onSaved }: {
  readonly t: TranslateNS<'sandore'>
  readonly definitionId: string
  getYaml(id: string): Promise<string>
  readonly save: SaveDefinition
  onSaved(id: string): void
}) {
  const [state, setState] = useState<DefinitionLoadState>({ kind: 'loading' })

  // 拉取定义 YAML；组件卸载或 id 变化后丢弃过期结果。
  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    getYaml(definitionId)
      .then(yaml => { if (alive) setState({ kind: 'ready', yaml }) })
      .catch(error => { if (alive) setState({ kind: 'error', message: describeError(error) }) })
    return () => { alive = false }
  }, [definitionId, getYaml])

  if (state.kind === 'loading') {
    return <p className={css.loading}>{t('panel.loading')}</p>
  }
  if (state.kind === 'error') {
    return <p className={css.errorText} role="alert">{t('view.editor.error', { message: state.message })}</p>
  }
  return (
    <DagEditor key={definitionId} t={t} initialYaml={state.yaml} initialId={definitionId} save={save} onSaved={onSaved} />
  )
}

/** 渲染 WorkflowView（双栏工作区）。 */
export function WorkflowView({
  useWorkspaces, listInstances, listDefinitions, deleteDefinition, getYaml, save, remote, openSession, t,
}: WorkflowViewProps) {
  const workspaces = useWorkspaces(state => state.items)
  const selection = useSyncExternalStore(subscribeSelection, getSelection)
  const [orchestrating, setOrchestrating] = useState(false)
  const [query, setQuery] = useState('')
  const [listKey, setListKey] = useState(0)

  const refreshList = (): void => { setListKey(key => key + 1) }

  const selectInstance = (instanceId: string): void => {
    setSelection({ kind: 'instance', id: instanceId })
    refreshList()
  }

  const selectDefinition = (definitionId: string, initialYaml: string): void => {
    setSelection({ kind: 'definition', id: definitionId, initialYaml })
    refreshList()
  }

  const selectNewDefinition = (): void => {
    setSelection({ kind: 'definition' })
    refreshList()
  }

  const renderEditor = (): ReactNode => {
    if (selection === null) {
      return <div className={css.placeholder}>{t('view.placeholder')}</div>
    }
    if (selection.kind === 'instance') {
      return (
        <RunView
          key={selection.id}
          t={t}
          instanceId={selection.id}
          openDiscussion={() => { openSession(selection.id) }}
          remote={remote}
        />
      )
    }
    if (selection.id !== undefined && selection.initialYaml === undefined) {
      return <DefinitionLoader key={selection.id} t={t} definitionId={selection.id} getYaml={getYaml} save={save} onSaved={refreshList} />
    }
    return (
      <DagEditor
        key={selection.id ?? 'new'}
        t={t}
        initialYaml={selection.initialYaml}
        initialId={selection.id}
        save={save}
        onSaved={refreshList}
      />
    )
  }

  return (
    <div className={css.root} data-sandore-view data-conversation-composer-overlay>
      <div className={css.workspace}>
        <aside className={css.sidebar} data-sandore-view-sidebar>
          <header className={css.sidebarHeader}>
            <div className={css.sidebarTitleRow}>
              <span className={css.sidebarTitle}>{t('panel.title')}</span>
              <Pill active={orchestrating} onClick={() => { setOrchestrating(value => !value) }}>
                {t('panel.orchestrate')}
              </Pill>
            </div>
            <div className={css.sidebarToolbar}>
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
                disabled={!orchestrating}
                title={orchestrating ? undefined : t('panel.add.instance.hint')}
                onClick={selectNewDefinition}
              >
                {orchestrating ? t('panel.add.definition') : t('panel.add.instance')}
              </Button>
            </div>
          </header>
          <div className={css.sidebarBody} data-sandore-view-list>
            {orchestrating ? (
              <DefinitionList
                key={`def-${listKey}`}
                t={t}
                query={query}
                listDefinitions={listDefinitions}
                deleteDefinition={deleteDefinition}
                onOpen={selectDefinition}
              />
            ) : (
              <InstanceList
                key={`inst-${listKey}`}
                t={t}
                workspaces={workspaces}
                query={query}
                listInstances={listInstances}
                onOpen={selectInstance}
              />
            )}
          </div>
        </aside>
        <main className={css.editor} data-sandore-view-editor>
          {renderEditor()}
        </main>
      </div>
      {/* 底部预留条：悬浮 composer 停靠于此，不遮挡工作区内容。 */}
      <div className={css.composerReserve} aria-hidden />
    </div>
  )
}
