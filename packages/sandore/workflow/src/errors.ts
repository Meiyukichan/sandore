/**
 * sandore 工作流引擎的类型化错误（re-export）。
 *
 * `SandoreError`/`SandoreErrorCode`/`isFatalSandoreError` 的实现已下沉至
 * microflow 包（`@deepseek-ai/dsh-sandore-microflow/src/errors.ts`），此处仅
 * re-export 以保持 workflow 包对外 API 不变。依赖方向统一为 workflow → microflow，
 * microflow 不再跨包导入 workflow 的运行时值。
 * @module @deepseek-ai/dsh-sandore-workflow/src/errors
 */
export { SandoreError, isFatalSandoreError } from '@deepseek-ai/dsh-sandore-microflow/src/errors';
export type { SandoreErrorCode } from '@deepseek-ai/dsh-sandore-microflow/src/errors';
export { WorkflowYamlError } from './yaml-error.ts';
export type { WorkflowYamlErrorCode } from './yaml-error.ts';
