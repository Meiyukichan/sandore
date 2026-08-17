/**
 * 工作流 UI 的模块级状态（overlay 开关 / 左列表模式 / 编辑区模式 / 选中项 / 面板宽度）。
 *
 * 自实现 getSnapshot/subscribe（DSH bundle 的 ModuleLoader 格式无法被 bundler
 * 静态分析出 `createSnapshotStore` 具名导出，故不依赖 dsh-client-runtime）。
 * 状态跨 overlay 开合与会话切换保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-store
 */

/** 编辑区模式：编排（DagEditor 画布）| 执行（RunView 三栏）。 */
export type EditorMode = 'dag' | 'run'

/** 定义视图：详情（默认）| 编排（两层 DAG）。 */
export type DefinitionView = 'detail' | 'edit'

/** 左列表模式：实例列表 | 定义列表（编排）。 */
export type ListMode = 'instance' | 'definition'

/** 右栏预览目标（树形导航叶子点击后出现）。 */
export interface PreviewTarget {
  /** 叶子节点 id（供树形导航高亮匹配）。 */
  readonly leafId?: string | undefined
  readonly kind: 'result' | 'artifact'
  /** 归属 Step id。 */
  readonly stepId: string
  /** 展示名称。 */
  readonly name: string
  /** 元信息（如文件路径 / 大小占位）。 */
  readonly meta?: string | undefined
  /** 预览正文（returnPrompt 或文件路径集合）。 */
  readonly text?: string | undefined
}

/** 工作流 UI 的全局状态快照。 */
export interface WorkflowUiState {
  /** overlay 是否打开。 */
  readonly open: boolean
  /** 编辑区模式（编排/执行）。 */
  readonly mode: EditorMode
  /** 定义视图（详情/编排，编排态生效）。 */
  readonly definitionView: DefinitionView
  /** 左列表模式（实例/定义）。 */
  readonly listMode: ListMode
  /** 当前选中实例（执行态）。 */
  readonly selectedInstanceId: string | undefined
  /** 当前选中定义（编排态；id 缺省 = 新建）。 */
  readonly selectedDefinition: { readonly id?: string | undefined; readonly initialYaml?: string | undefined } | undefined
  /** 右栏预览目标（null = 关闭）。 */
  readonly preview: PreviewTarget | null
  /** 左列表列宽（px）。 */
  readonly listWidth: number
  /** RunView 树形导航列宽（px）。 */
  readonly treeWidth: number
  /** RunView 预览列宽（px）。 */
  readonly previewWidth: number
}

const INITIAL: WorkflowUiState = {
  open: false,
  mode: 'dag',
  definitionView: 'detail',
  listMode: 'instance',
  selectedInstanceId: undefined,
  selectedDefinition: undefined,
  preview: null,
  listWidth: 300,
  treeWidth: 240,
  previewWidth: 380,
}

let state: WorkflowUiState = INITIAL
const listeners = new Set<() => void>()

/** 当前状态快照（稳定引用，仅 set 时更换）。 */
export function getWorkflowState(): WorkflowUiState {
  return state
}

/** 订阅状态变更。 */
export function subscribeWorkflowState(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 合并补丁更新状态并通知订阅者。 */
export function setWorkflowState(patch: Partial<WorkflowUiState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** 打开 overlay。 */
export function openWorkflowOverlay(): void {
  setWorkflowState({ open: true })
}

/** 关闭 overlay（保留选中态，便于再次打开）。 */
export function closeWorkflowOverlay(): void {
  setWorkflowState({ open: false })
}

/** 选中实例：切执行态 + 清定义选中 + 关预览。 */
export function selectInstance(instanceId: string): void {
  setWorkflowState({
    mode: 'run',
    selectedInstanceId: instanceId,
    selectedDefinition: undefined,
    preview: null,
  })
}

/** 选中定义：切编排态（默认显示详情）+ 清实例选中 + 关预览。 */
export function selectDefinition(id: string, initialYaml: string): void {
  setWorkflowState({
    mode: 'dag',
    definitionView: 'detail',
    selectedDefinition: { id, initialYaml },
    selectedInstanceId: undefined,
    preview: null,
  })
}

/** 新建定义：切编排态，直接进入空白 DagEditor。 */
export function newDefinition(): void {
  setWorkflowState({
    mode: 'dag',
    definitionView: 'edit',
    selectedDefinition: undefined,
    selectedInstanceId: undefined,
    preview: null,
  })
}

/** 更新列表列宽（拖拽分隔条，带边界钳制）。 */
export function resizeListWidth(delta: number): void {
  setWorkflowState({ listWidth: clamp(state.listWidth + delta, 200, 520) })
}

/** 更新树形导航列宽（拖拽分隔条，带边界钳制）。 */
export function resizeTreeWidth(delta: number): void {
  setWorkflowState({ treeWidth: clamp(state.treeWidth + delta, 180, 420) })
}

/** 更新预览列宽（拖拽分隔条，带边界钳制）。 */
export function resizePreviewWidth(delta: number): void {
  setWorkflowState({ previewWidth: clamp(state.previewWidth + delta, 280, 640) })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
