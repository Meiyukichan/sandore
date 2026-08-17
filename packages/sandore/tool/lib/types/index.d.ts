/**
 * sandore 工作流引擎的 8 个编排器模型工具。
 *
 * 以 `defineTool` 形状（`name`/`description`/`parameters`/`output`/`execute`）导出
 * 结构化工具定义，经宿主主代理 `setup(agentCtx)` 的 `agentCtx.tools.register` 逐个
 * 注册。工具 `execute` 全部转调 `engine` 实例级方法并闭包捕获 `instanceId`，不持有
 * 业务状态；对 completed 实例的 resume/retry/pause 类工具与终态实例的 abort 返回
 * 结构化 no-op（含原因），`getState` 对任意状态只读可用；engine 抛出的 `SandoreError`
 * 摘要透传为错误结果。
 *
 * 本包对 workflow 仅 `import type`（依赖方向 tool → workflow 单向 type-only），
 * 无任何运行时 import。
 * @module @deepseek-ai/dsh-sandore-tool/src/index
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DagInstanceState, DagRun } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { SandoreEngineSurface } from '@deepseek-ai/dsh-sandore-workflow/src/engine-surface';
/** 创建编排器工具的入参。 */
export interface CreateSandoreToolsOptions {
    /** 工作流实例 ID（每个工具 execute 闭包捕获）。 */
    readonly instanceId: string;
    /** 工作流引擎实例（工具逻辑全部转调其方法）。 */
    readonly engine: SandoreEngineSurface;
}
/** engine 抛出的 `SandoreError` 摘要（稳定 `code` + 人类可读 `message`）。 */
export interface SandoreErrorSummary {
    /** 稳定机器可路由错误码。 */
    readonly code: string;
    /** 人类可读错误信息。 */
    readonly message: string;
}
/** 工具统一执行结果信封。 */
export interface SandoreToolResult {
    /** 操作是否成功；no-op 与错误均返回 false。 */
    readonly ok: boolean;
    /** `ok === false` 时的人类可读原因（no-op 或错误说明）。 */
    readonly reason?: string;
    /** engine 抛出的 `SandoreError` 摘要（仅错误场景存在）。 */
    readonly error?: SandoreErrorSummary;
    /** `sandore_getState` 的状态快照。 */
    readonly state?: DagInstanceState;
    /** `sandore_startInstance` 返回的运行句柄。 */
    readonly run?: DagRun;
}
/** `defineTool` 形状的结构化工具定义（DSH `ToolDefinition` 最小结构面）。 */
export interface SandoreToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly output: {
        readonly schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: unknown): Promise<unknown>;
}
/**
 * 创建 8 个 `sandore_*` 编排器工具。
 *
 * 每个工具 `execute` 转调 `engine` 的对应实例级方法并闭包捕获 `instanceId`；工具不
 * 持有任何业务状态。返回数组可经宿主主代理 `setup(agentCtx)` 内
 * `agentCtx.tools.register(tool)` 逐个注册。
 * @param options - 实例 ID 与引擎实例。
 * @returns 8 个工具定义（名称与转调映射见 spec）。
 */
export declare function createSandoreTools(options: CreateSandoreToolsOptions): SandoreToolDefinition[];
//# sourceMappingURL=index.d.ts.map