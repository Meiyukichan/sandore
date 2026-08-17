/**
 * 工作流 overlay 的业务 face（shell.overlay 条目注入；RPC 已在 index.ts 解包）。
 *
 * 覆盖左列表（实例/定义）、编辑区（DagEditor 编排 / RunView 执行）与测试运行
 * 所需的全部 `ctx.remote.sandore` 访问面。`remote` 为 RunView 控件所需的最小 RPC 面。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-face
 */
import type { DagRun, InstanceSummary, JobEntry, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'

import type { SaveDefinition } from './sandore-save.ts'
import type { RunViewRemote } from './RunView.tsx'

/** WorkflowOverlay 接收的业务 face。 */
export interface WorkflowOverlayFace {
  /** 拉取实例摘要（RPC 已解包）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** 拉取定义列表（RPC 已解包）。 */
  listDefinitions(): Promise<WorkflowDefinitionEntry[]>
  /** 按 workflowId 过滤拉取 Job 列表（RPC 已解包）。 */
  listJobs(workflowId?: string): Promise<JobEntry[]>
  /** 创建 Job（测试运行用；RPC 已解包）。 */
  createJob(input: { name: string; workflowId: string; cwd?: string }): Promise<JobEntry>
  /** 启动实例（测试运行用；RPC 已解包）。 */
  startInstance(input: { jobId: string; originalInput: string; cwd?: string }): Promise<DagRun>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /** 读取定义原始 YAML（RPC 已解包）。 */
  getYaml(id: string): Promise<string>
  /** DagEditor 保存回调（createSandoreSave 接线）。 */
  save: SaveDefinition
  /** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
  remote: RunViewRemote
  /** 打开宿主会话（RunView「查看详情/打开讨论」跳实例或子代理会话）。 */
  openSession(id: string): void
}
