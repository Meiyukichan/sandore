/**
 * sandore 引擎使用的 `ctx.shell` 能力接缝（本地结构类型声明）。
 *
 * `@deepseek-ai/dsh-shell` 未作为 sandore 的运行时依赖安装，本文件按 DSH 公开
 * API 复刻 Step 执行所需的最小结构类型（`resolve`/`run`/`start` + 请求/规格/
 * 结果），并声明 `ctx.shell` 上下文键。宿主运行时注入的真实 `ShellExecutor`
 * 结构兼容即可，无需包级依赖。
 * @module @deepseek-ai/dsh-sandore-workflow/src/shell
 */

/** 捕获输出（stdout/stderr）：截断时 `text` 保留尾部。 */
export interface CollectedOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

/** shell 执行请求（`resolve` 的入参）。 */
export interface ShellExecRequest {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: Record<string, string>;
}

/** shell 执行规格（`resolve` 补全必填字段后的产物）。 */
export interface ShellExecSpec {
  command: string;
  workdir: string;
  timeoutMs: number;
  stdoutMaxBytes: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: Record<string, string>;
}

/** 前台命令执行结果：非零退出/超时/中止都 resolve 为该结果（只有基础设施故障才 reject）。 */
export interface ShellRunResult {
  /** 退出码；被信号杀死时为 null。 */
  exitCode: number | null;
  /** 终止信号名；正常退出为 null。 */
  signal: string | null;
  /** 执行器自身超时是首个终止原因。 */
  timedOut: boolean;
  /** 调用方 AbortSignal 是首个终止原因（与 timedOut 互斥）。 */
  aborted: boolean;
  /** 本次生效的超时（毫秒）。 */
  timeoutMs: number;
  stdout: CollectedOutput;
  stderr: CollectedOutput;
}

/** `ctx.shell` 能力接缝。 */
export interface ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec;
  run(spec: ShellExecSpec): Promise<ShellRunResult>;
  start(spec: ShellExecSpec): unknown;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor;
  }
}
