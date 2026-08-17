/**
 * DagEditor 保存流程的接线与错误归一化（无 React 依赖，可单测）。
 *
 * `createSandoreSave` 把 `ctx.remote.sandore` 的 RPC 面接成 DagEditor 的
 * `save(id, yaml)` 回调：`id === undefined` 走 `createDefinition({ yaml })`，
 * 否则走 `updateYaml(id, yaml)`，均经 `unwrap` 解包并返回保存后的 id。
 * `describeSaveError` 把各类错误统一为含「校验详情」的 `SaveErrorInfo`，
 * 供 DagEditor 的错误分支呈现，而非只回落 message 文案。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-save
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'
import { WorkflowYamlError } from '@deepseek-ai/dsh-sandore-workflow/src/yaml-error'

import { SandoreRemoteError, unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'

/** `createSandoreSave` 所需的最小 remote 面（`ctx.remote.sandore` 结构满足）。 */
export interface SandoreSaveRemote {
  createDefinition(input: { yaml: string }): Promise<RemoteResult<WorkflowDefinitionEntry>>
  updateYaml(id: string, yaml: string): Promise<RemoteResult<WorkflowDefinitionEntry>>
}

/** DagEditor 的保存回调签名：`id` 为 `undefined` 时新建，否则更新 YAML；返回保存后的 id。 */
export type SaveDefinition = (id: string | undefined, yaml: string) => Promise<string>

/**
 * 构造 save 回调：`id === undefined` 走 `createDefinition`，否则走 `updateYaml`，
 * 返回持久化后的 id。新建首次 `createDefinition`、后续 `updateYaml` 的行为在此成可执行路径。
 * @param remote - `ctx.remote.sandore` 的最小 RPC 面。
 * @returns 供 DagEditor `save` prop 直接使用的回调。
 */
export function createSandoreSave(remote: SandoreSaveRemote): SaveDefinition {
  return async (id, yaml) => {
    if (id === undefined) {
      return unwrap(await remote.createDefinition({ yaml })).id
    }
    return unwrap(await remote.updateYaml(id, yaml)).id
  }
}

/** 保存失败归一化结果：`details` 为可直接展示的校验详情文案（无详情时为 `undefined`）。 */
export interface SaveErrorInfo {
  readonly message: string
  readonly details: string | undefined
}

/** 收窄任意值为 `Record<string, unknown>`。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 收窄携带 zod `issues` 数组的错误载体（`ZodError` 及挂在其 `cause` 上的实例）。 */
function isZodIssueCarrier(value: unknown): value is { issues: readonly unknown[] } {
  return isRecord(value) && Array.isArray(value.issues)
}

/** 渲染单个 zod issue 为 `path: message`（无 path 时仅 message）。 */
function describeZodIssue(issue: unknown): string {
  if (!isRecord(issue)) return String(issue)
  const path = Array.isArray(issue.path) ? issue.path.map(value => String(value)).join('.') : ''
  const message = typeof issue.message === 'string' ? issue.message : String(issue.message ?? '')
  return path === '' ? message : `${path}: ${message}`
}

/** 渲染 zod issues 数组为分号分隔的摘要。 */
function describeZodIssues(issues: readonly unknown[]): string {
  return issues.map(describeZodIssue).join('; ')
}

/** 渲染 `WorkflowYamlError` 的校验详情：有 zod cause 取 issues 摘要，否则回落稳定 code。 */
function describeWorkflowYamlError(error: WorkflowYamlError): string {
  if (isZodIssueCarrier(error.cause)) {
    return describeZodIssues(error.cause.issues)
  }
  return error.code
}

/**
 * 把保存流程抛出的任意错误归一化为含校验详情的 `SaveErrorInfo`：
 * `SandoreRemoteError` 取 `.details`、`WorkflowYamlError` 取 `.code`/`.cause`、
 * zod 错误取 issues 摘要，其余回落 message。
 * @param error - 保存流程 catch 到的未知抛错值。
 * @returns 含统一 message 与可选校验详情的归一化结果。
 */
export function describeSaveError(error: unknown): SaveErrorInfo {
  if (error instanceof SandoreRemoteError) {
    return { message: error.message, details: JSON.stringify(error.details) }
  }
  if (error instanceof WorkflowYamlError) {
    return { message: error.message, details: describeWorkflowYamlError(error) }
  }
  if (isZodIssueCarrier(error)) {
    return { message: describeError(error), details: describeZodIssues(error.issues) }
  }
  return { message: describeError(error), details: undefined }
}
