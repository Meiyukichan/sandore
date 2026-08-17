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
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
/** `createSandoreSave` 所需的最小 remote 面（`ctx.remote.sandore` 结构满足）。 */
export interface SandoreSaveRemote {
    createDefinition(input: {
        yaml: string;
    }): Promise<RemoteResult<WorkflowDefinitionEntry>>;
    updateYaml(id: string, yaml: string): Promise<RemoteResult<WorkflowDefinitionEntry>>;
}
/** DagEditor 的保存回调签名：`id` 为 `undefined` 时新建，否则更新 YAML；返回保存后的 id。 */
export type SaveDefinition = (id: string | undefined, yaml: string) => Promise<string>;
/**
 * 构造 save 回调：`id === undefined` 走 `createDefinition`，否则走 `updateYaml`，
 * 返回持久化后的 id。新建首次 `createDefinition`、后续 `updateYaml` 的行为在此成可执行路径。
 * @param remote - `ctx.remote.sandore` 的最小 RPC 面。
 * @returns 供 DagEditor `save` prop 直接使用的回调。
 */
export declare function createSandoreSave(remote: SandoreSaveRemote): SaveDefinition;
/** 保存失败归一化结果：`details` 为可直接展示的校验详情文案（无详情时为 `undefined`）。 */
export interface SaveErrorInfo {
    readonly message: string;
    readonly details: string | undefined;
}
/**
 * 把保存流程抛出的任意错误归一化为含校验详情的 `SaveErrorInfo`：
 * `SandoreRemoteError` 取 `.details`、`WorkflowYamlError` 取 `.code`/`.cause`、
 * zod 错误取 issues 摘要，其余回落 message。
 * @param error - 保存流程 catch 到的未知抛错值。
 * @returns 含统一 message 与可选校验详情的归一化结果。
 */
export declare function describeSaveError(error: unknown): SaveErrorInfo;
//# sourceMappingURL=sandore-save.d.ts.map