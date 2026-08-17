/**
 * sandore microflow 包入口。
 *
 * 暴露 Stage/Step 执行层（`StepRunner` 与 `StageExecutor`）与类型化错误
 * （`SandoreError`）供 workflow 引擎组合使用。运行时依赖方向为 workflow →
 * microflow；microflow 对 workflow 仅 `import type` 结构类型。
 * @module @deepseek-ai/dsh-sandore-microflow
 */
export * from "./errors.js";
export * from "./file-utils.js";
export * from "./branch-evaluator.js";
export * from "./finalize-manager.js";
export * from "./loop-manager.js";
export * from "./step-runner.js";
export * from "./stage-executor.js";
export * from "./subagents.js";
//# sourceMappingURL=index.js.map