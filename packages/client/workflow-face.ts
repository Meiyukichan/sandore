/**
 * 工作流视图的业务 face（index.ts 装配后经 seat-bridge 注入；RPC 已解包）。
 *
 * 覆盖左列表（实例/定义）、编辑区（DagEditor 编排 / RunView 执行）与测试运行
 * 所需的全部 `ctx.remote.sandore` 访问面。`remote` 为 RunView 控件所需的最小 RPC 面。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-face
 */
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  DagRun, ImportDefinitionResult, InstanceSummary, LibraryEntrySummary, MicroflowRecord, StepRecord,
  WorkflowDefinitionEntry,
} from '@meiyukichan/dsh-sandore/remote'

import type { SaveDefinition } from './sandore-save.ts'
import type { RunViewRemote } from './RunView.tsx'
import type {
  ModelDirectoryFace, ObservableFace, PermissionSelectValue,
} from './model-faces.ts'

/** 创建实例时选择的模型（对齐 Host `StartInstanceInput.model`）。 */
export interface StartModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 新增实例入参（去 job 概念：直接绑定工作流定义 + 工作目录 + 模型 + 权限）。 */
export interface StartInstanceParams {
  workflowId: string
  originalInput: string
  /** 必填工作目录：hostAgent 据此 attach 到对应的 web workspace。 */
  cwd: string
  model?: StartModelSelection
  permission?: string
}

/** 模型目录条目（弹窗模型下拉数据源，来自 `ctx.llm` 目录）。 */
export interface ModelDirectoryEntry {
  provider: string
  providerName: string
  models: { id: string; name: string }[]
}

/** WorkflowOverlay 接收的业务 face。 */
export interface WorkflowOverlayFace {
  /** 拉取实例摘要（RPC 已解包）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** 拉取定义列表（RPC 已解包）。 */
  listDefinitions(): Promise<WorkflowDefinitionEntry[]>
  /** 启动实例（新增实例弹窗 / 测试运行；RPC 已解包）。 */
  startInstance(input: StartInstanceParams): Promise<DagRun>
  /** 模型目录（弹窗模型下拉数据源；RPC 已解包）。 */
  listModelDirectory(): Promise<ModelDirectoryEntry[]>
  /** 打开 DSH 原生目录选择器（新增实例的工作目录；无原生能力的环境会抛错）。 */
  pickDirectory(): Promise<string | undefined>
  /** 经 Host `browse` 能力列出一个目录层级（缺省 = 宿主主目录；与 DSH 添加项目同一后端）。 */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /** 经 Host `browse` 能力在指定父目录下新建一个子目录。 */
  createDirectory(path: string, name: string): Promise<string>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /**
   * 从 YAML 导入一条工作流定义（RPC 已解包：`importDefinitionFromYaml`）。
   * 按 name 匹配：不存在则新建，版本不同则更新，同版本跳过。
   */
  importDefinition(yaml: string): Promise<ImportDefinitionResult>
  /** 删除实例（RPC 已解包；state 表行级删除）。 */
  deleteInstance(instanceId: string): Promise<boolean>
  /** 读取定义原始 YAML（RPC 已解包）。 */
  getYaml(id: string): Promise<string>
  // ── 三级分离：Step / Microflow 库（RPC 已解包） ──────────────────────────
  /** 列出 Step 库条目摘要（含被引用数；UI 名「Agent 库」）。 */
  listSteps(): Promise<LibraryEntrySummary[]>
  /** 读取 Step 库条目。 */
  getStep(id: string): Promise<StepRecord>
  /** 写入/覆盖 Step 库条目（传 YAML 文本；Host 端查重 + 解析）。 */
  upsertStep(yaml: string): Promise<StepRecord>
  /** 删除 Step 库条目（被引用时 Host 抛 REFERENCED）。 */
  deleteStep(id: string): Promise<boolean>
  /** 列出 Microflow 库条目摘要（含被引用数）。 */
  listMicroflows(): Promise<LibraryEntrySummary[]>
  /** 读取 Microflow 库条目。 */
  getMicroflow(id: string): Promise<MicroflowRecord>
  /** 写入/覆盖 Microflow 库条目（传 YAML 文本；Host 端查重 + 解析）。 */
  upsertMicroflow(yaml: string): Promise<MicroflowRecord>
  /** 删除 Microflow 库条目（被引用时 Host 抛 REFERENCED）。 */
  deleteMicroflow(id: string): Promise<boolean>
  /** DagEditor 保存回调（createSandoreSave 接线）。 */
  save: SaveDefinition
  /** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
  remote: RunViewRemote
  /** 打开宿主会话（RunView「查看详情/打开讨论」跳实例或子代理会话）。 */
  openSession(id: string): void
  /** 某会话的共享模型目录（复用 DSH `ctx.modelDirectories`，行为与主 session 一致）。 */
  modelDirectory(sessionId: string): ModelDirectoryFace
  /** 某会话的权限投影（`projections.permissions`，可订阅）。 */
  permissions(sessionId: string): ObservableFace<PermissionSelectValue | undefined>
  /** 对某会话执行一行命令（`/permission <id>` 等，走 DSH `remote.commands`）。 */
  runCommand(sessionId: string, line: string): Promise<boolean>
  /** 权限投影缺失时的回退：经 `/permission`（无参）查询当前预设与可用列表。 */
  queryPermission(sessionId: string): Promise<PermissionSelectValue | undefined>
}
