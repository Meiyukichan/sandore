/**
 * sandore microflow 包入口。
 *
 * 暴露 Stage/Step 执行层（`StepRunner` 与 `StageExecutor`）与类型化错误
 * （`SandoreError`）供 workflow 引擎组合使用。运行时依赖方向为 workflow →
 * microflow；microflow 对 workflow 仅 `import type` 结构类型。
 * @module @deepseek-ai/dsh-sandore-microflow
 */
export * from './errors.ts';
export * from './file-utils.ts';
export * from './branch-evaluator.ts';
export * from './finalize-manager.ts';
export * from './loop-manager.ts';
export * from './rules-resolver.ts';
export * from './step-runner.ts';
export * from './stage-executor.ts';
export * from './subagents.ts';
