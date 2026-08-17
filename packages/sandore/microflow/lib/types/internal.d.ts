/**
 * microflow 包内部工具函数（不进入公开 API）。
 *
 * `describeError`/`textSummary`/`splitCommand`/`resolvePassThroughVars`/
 * `buildShellEnv`/`resolveProviderModel` 仅供本包内部模块（`step-runner.ts`/
 * `branch-evaluator.ts`/`stage-executor.ts`/`file-utils.ts`）复用，不从 `index.ts`
 * re-export，避免泄漏到 microflow 公开 API。
 * @module @deepseek-ai/dsh-sandore-microflow/src/internal
 */
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm';
/** 渲染任意抛出值为可读消息（诊断用，永不按消息路由）。 */
export declare function describeError(error: unknown): string;
/**
 * 判定错误是否为「取消类错误」（`interrupt` 打断 `whenIdle`/执行 Promise 时以取消
 * 结束）。`SandoreError` 按稳定 `code === 'CANCELLED'` 路由；非 SandoreError 回退
 * 识别 `AbortError` 名称或含 `cancel` 的消息（兼容 DSH 原生取消错误的形状）。
 */
export declare function isCancellationError(error: unknown): boolean;
/** 提取 ContentBlock[] 的纯文本摘要（仅 text 块，按序拼接）。 */
export declare function textSummary(output: readonly ContentBlock[] | undefined): string;
/**
 * 将命令串拆分为 argv（subprocess 不 shell 解释）。
 *
 * 仅做最简空白分词并支持单引号/双引号包裹含空格的单个 token（引号本身不保留，
 * 不做嵌套/转义/变量展开）。因此本函数仅适用于「无空格程序名 + 无特殊字符参数」
 * 的命令；含重定向、管道、变量展开等复杂命令应经 schema 层显式提供 `argv`。
 */
export declare function splitCommand(command: string): string[];
/** 解析透传变量 + 循环上下文特殊变量（`in-loop-turn`/`all-loop-turn`）。 */
export declare function resolvePassThroughVars(passThroughVars: Readonly<Record<string, string>> | undefined, loopTurn: number | undefined, loopMaxIterations: number | undefined): Record<string, string>;
/** 组装 shell 注入用环境变量（非空透传变量 + 循环上下文；无需求返回 undefined）。 */
export declare function buildShellEnv(passThroughVars: Readonly<Record<string, string>> | undefined, loopTurn: number | undefined, loopMaxIterations: number | undefined): Record<string, string> | undefined;
/** provider/model 三层回退取值域（Step/条件定义内成对提供的 providerId/modelId）。 */
export interface ModelRouteValue {
    readonly providerId?: string | undefined;
    readonly modelId?: string | undefined;
    readonly [key: string]: unknown;
}
/** provider/model 三层回退的 L2 来源（引擎默认 provider/model）。 */
export interface ModelRouteDefaults {
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
}
/**
 * provider/model 三层回退：L1 定义 `providerId`+`modelId` 成对提供 → L2 引擎默认
 * `defaultProvider`+`defaultModel` 成对配置 → L3 `llm` 目录兜底（`listProviders`
 * 同步、`listModels` 异步）。L3 命中时可选回调 `onDirectoryFallback`（记录告警）。
 */
export declare function resolveProviderModel(value: ModelRouteValue, defaults: ModelRouteDefaults, llm: LlmRuntime, onDirectoryFallback?: (providerId: string, modelId: string) => void): Promise<{
    provider: string;
    model: string;
}>;
//# sourceMappingURL=internal.d.ts.map