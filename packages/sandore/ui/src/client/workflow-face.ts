/**
 * 工作流 overlay 的业务 face（shell.overlay 条目注入；RPC 已在 index.ts 解包）。
 *
 * 覆盖左列表（实例/定义）、编辑区（DagEditor 编排 / RunView 执行）与测试运行
 * 所需的全部 `ctx.remote.sandore` 访问面。`remote` 为 RunView 控件所需的最小 RPC 面。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-face
 */
import type { DagRun, InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'

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
  /** 打开 DSH 原生目录选择器（新增实例的工作目录）。 */
  pickDirectory(): Promise<string | undefined>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /** 删除实例（RPC 已解包；state 表行级删除）。 */
  deleteInstance(instanceId: string): Promise<boolean>
  /** 读取定义原始 YAML（RPC 已解包）。 */
  getYaml(id: string): Promise<string>
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
