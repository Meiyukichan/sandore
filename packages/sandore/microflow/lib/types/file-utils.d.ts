/**
 * 产物收集与输入解析工具集（纯函数 + 文件系统接缝）。
 *
 * 提供四组能力：
 * - 透传变量替换：`replacePassThroughVars`（含 `in-loop-turn`/`all-loop-turn`）；
 * - glob→regex 转换与自动区分：`globToRegex`/`escapeRegexChar`/`isGlobPattern`；
 * - 递归文件搜索：`walkDir`/`findFilesByGlob`/`findFilesByRegex`；
 * - 产物文件读写：`writeOutputJson`/`readOutputJson`（`{uuid}_output.json`）；
 * - InputFrom 就近匹配：`resolvePathSegments`/`resolveFromInputFrom`/`idMatches`。
 *
 * 文件系统经 `FileSystem` 结构类型接缝（target 导向两段式协议：先 `resolve` 得
 * `FsTarget`，再以 target 调 `listDir`/`readText`/`writeText`）注入，函数接受
 * `fs` 结构类型作为入参，不硬绑 `ctx`。`@deepseek-ai/dsh-fs` 未作为 sandore 运行
 * 时依赖安装，本文件按 `shell.ts`/`subagents.ts` 范式复刻最小结构类型并声明
 * `ctx.fs` 上下文键，宿主运行时注入的真实服务结构兼容即可。
 * @module @deepseek-ai/dsh-sandore-microflow/src/file-utils
 */
import type { ExecutedStepDefault, InputFromItem } from '@deepseek-ai/dsh-sandore-workflow/src/types';
/** 不透明文件系统目标（`resolve` 返回；`targetKey` 仅供后端识别）。 */
export interface FsTarget {
    readonly targetKey: string;
    readonly displayPath: string;
}
/** `listDir` 返回的单个子项（`type` 判定目录性，`target` 供后续递归/读写）。 */
export interface FsDirEntry {
    readonly name: string;
    readonly type: 'file' | 'directory' | 'other';
    readonly target: FsTarget;
}
/** `writeText` 的写入结果。 */
export interface FsWriteOutcome {
    readonly operation: 'create' | 'update';
    readonly version: string;
    readonly before: string | null;
    readonly after: string;
}
/** 文件系统最小结构接缝（target 导向）。 */
export interface FileSystem {
    resolve(path: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<FsTarget>;
    processPath(target: FsTarget): string;
    listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        fs: FileSystem;
    }
}
/** 替换 `${xxx}` 透传变量：已定义替换为值，未定义保留原文。 */
export declare function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string;
/** 转义单个正则元字符（非元字符原样返回）。 */
export declare function escapeRegexChar(char: string): string;
/** 将 glob 模式转换为锚定正则：`*`→`[^/]*`、`**`→`.*`（跳过后续 `/`）、`?`→`[^/]`。 */
export declare function globToRegex(glob: string): RegExp;
/** 含 `*`/`?` 且无 regex 特征（反斜杠转义或 `(?`）时判定为 glob，否则视为 regex/字面路径。 */
export declare function isGlobPattern(pattern: string): boolean;
/** 递归遍历目录，返回全部文件的进程绝对路径数组。 */
export declare function walkDir(fs: FileSystem, dir: FsTarget): Promise<string[]>;
/** 按 glob 模式搜索 `rootDir` 下匹配的文件，返回进程绝对路径数组。 */
export declare function findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>;
/** 按正则搜索 `rootDir` 下相对路径匹配的文件，返回进程绝对路径数组。 */
export declare function findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>;
/** 单个 outputTo 的产物列表（写入 `{uuid}_output.json`）。 */
export interface OutputArtifact {
    readonly id: string;
    readonly value: string[];
}
/** `{uuid}_output.json` 的完整结构。 */
export interface StepOutputFile {
    readonly sessionId: string;
    readonly output: {
        readonly returnPrompt: string;
        readonly artifacts: OutputArtifact[];
    };
}
/** 由 stepMessageId 推导产物文件名。 */
export declare function outputJsonFileName(stepMessageId: string): string;
/** 写入 `{stepMessageId}_output.json`，返回文件进程绝对路径。 */
export declare function writeOutputJson(fs: FileSystem, dir: string, stepMessageId: string, data: StepOutputFile): Promise<string>;
/** 读回并校验 `{stepMessageId}_output.json`。 */
export declare function readOutputJson(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile>;
/** 后缀匹配：`actualId === targetId` 或 `actualId` 以 `targetId-` 开头（循环带后缀 id）。 */
export declare function idMatches(actualId: string, targetId: string): boolean;
/**
 * 按 `path` 就近匹配已执行 Step。
 *
 * 支持三种路径：`stg-xxx`（Stage 级，倒序最近优先）、`stg-xxx.step-xxx`
 * （Step 级，自当前条目前一条起往前最近匹配，`idMatches` 支持循环后缀 id）、
 * `stg-xxx.step-xxx.opt-xxx`（OutputTo 级，先定位 Step 再过滤特定 outputTo）。
 * @param executedSteps - 扁平已执行 Step（含循环迭代条目）。
 * @param currentIndex - 当前 Step 在 `executedSteps` 中的索引。
 * @param path - `stageId[.stepId[.outputToId]]` 引用路径。
 */
export declare function resolvePathSegments(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, path: string): ExecutedStepDefault[];
/**
 * 解析 `inputFromItems` 为就近命中的已执行 Step。
 *
 * 每项 `path` 走 {@link resolvePathSegments}，`regex` 遍历全部 Step 输出文本做正则
 * 匹配（倒序最近优先）；`inputFromItems` 为空时回退前一条执行条目
 * （`currentIndex - 1`）。
 */
export declare function resolveFromInputFrom(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, inputFromItems: readonly InputFromItem[]): ExecutedStepDefault[];
//# sourceMappingURL=file-utils.d.ts.map