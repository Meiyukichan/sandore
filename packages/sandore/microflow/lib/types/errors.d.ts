/**
 * sandore 工作流引擎的类型化错误（microflow 包下沉实现）。
 *
 * `SandoreError` 对齐 DSH 的 `HarnessError`（稳定 `code` 可编程路由）+ `WorkflowError`
 * 的 `fatal` 标志范式：默认 `fatal === true` 表示组合子必须响亮传播（re-throw），
 * 恢复性错误（如 `PERSISTENCE_FAILED` 的单项重试）可传 `{ fatal: false }` 覆盖。
 *
 * 依赖方向统一为 workflow → microflow：workflow 包通过 re-export 保持对外 API 不变，
 * microflow 不再跨包导入 workflow 的运行时值。
 * @module @deepseek-ai/dsh-sandore-microflow/src/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * 沙盒工作流引擎的稳定机器可路由错误码。
 *
 * 路由时只按 `code` 判断，永不解析 `message`。Task 2 最小可用阶段只用到
 * `YAML_PARSE`（YAML 语法错误）与 `DEFINITION_INVALID`（Zod/引用完整性校验失败）。
 */
export type SandoreErrorCode = 'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED' | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED' | 'FINALIZE_FAILED' | 'GATE_FAILED' | 'SESSION_LOST' | 'PERSISTENCE_FAILED';
/**
 * 工作流引擎的类型化错误。
 *
 * 继承 {@link HarnessError}（故 `instanceof HarnessError` 为真），额外携带
 * `fatal` 标志：`fatal === true` 的错误必须让组合子响亮失败，普通子项失败才映射为
 * `null`。
 */
export declare class SandoreError extends HarnessError {
    /** 组合子必须传播此错误而非将项置 null。 */
    readonly fatal: boolean;
    constructor(message: string, code: SandoreErrorCode, options?: ErrorOptions & {
        fatal?: boolean;
    });
}
/**
 * 是否必须重新抛出 `error` 而非将项映射为 `null`。
 * @param error - 任意抛出的值；fatal 性由宿主 `instanceof` 判定。
 * @returns 当 `error` 是 `fatal` 的 {@link SandoreError} 时为 true。
 */
export declare function isFatalSandoreError(error: unknown): boolean;
//# sourceMappingURL=errors.d.ts.map