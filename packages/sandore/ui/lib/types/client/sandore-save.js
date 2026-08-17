import { WorkflowYamlError } from '@deepseek-ai/dsh-sandore-workflow/src/yaml-error';
import { SandoreRemoteError, unwrap } from "./remote.js";
import { describeError } from "./describe-error.js";
/**
 * 构造 save 回调：`id === undefined` 走 `createDefinition`，否则走 `updateYaml`，
 * 返回持久化后的 id。新建首次 `createDefinition`、后续 `updateYaml` 的行为在此成可执行路径。
 * @param remote - `ctx.remote.sandore` 的最小 RPC 面。
 * @returns 供 DagEditor `save` prop 直接使用的回调。
 */
export function createSandoreSave(remote) {
    return async (id, yaml) => {
        if (id === undefined) {
            return unwrap(await remote.createDefinition({ yaml })).id;
        }
        return unwrap(await remote.updateYaml(id, yaml)).id;
    };
}
/** 收窄任意值为 `Record<string, unknown>`。 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 收窄携带 zod `issues` 数组的错误载体（`ZodError` 及挂在其 `cause` 上的实例）。 */
function isZodIssueCarrier(value) {
    return isRecord(value) && Array.isArray(value.issues);
}
/** 渲染单个 zod issue 为 `path: message`（无 path 时仅 message）。 */
function describeZodIssue(issue) {
    if (!isRecord(issue))
        return String(issue);
    const path = Array.isArray(issue.path) ? issue.path.map(value => String(value)).join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message : String(issue.message ?? '');
    return path === '' ? message : `${path}: ${message}`;
}
/** 渲染 zod issues 数组为分号分隔的摘要。 */
function describeZodIssues(issues) {
    return issues.map(describeZodIssue).join('; ');
}
/** 渲染 `WorkflowYamlError` 的校验详情：有 zod cause 取 issues 摘要，否则回落稳定 code。 */
function describeWorkflowYamlError(error) {
    if (isZodIssueCarrier(error.cause)) {
        return describeZodIssues(error.cause.issues);
    }
    return error.code;
}
/**
 * 把保存流程抛出的任意错误归一化为含校验详情的 `SaveErrorInfo`：
 * `SandoreRemoteError` 取 `.details`、`WorkflowYamlError` 取 `.code`/`.cause`、
 * zod 错误取 issues 摘要，其余回落 message。
 * @param error - 保存流程 catch 到的未知抛错值。
 * @returns 含统一 message 与可选校验详情的归一化结果。
 */
export function describeSaveError(error) {
    if (error instanceof SandoreRemoteError) {
        return { message: error.message, details: JSON.stringify(error.details) };
    }
    if (error instanceof WorkflowYamlError) {
        return { message: error.message, details: describeWorkflowYamlError(error) };
    }
    if (isZodIssueCarrier(error)) {
        return { message: describeError(error), details: describeZodIssues(error.issues) };
    }
    return { message: describeError(error), details: undefined };
}
//# sourceMappingURL=sandore-save.js.map