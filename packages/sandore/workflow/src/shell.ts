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

// ── subprocess 接缝（stdin/env 注入与原始 stdio） ─────────────────────────

/** stdin 处置：`ignore` 挂 `/dev/null`；`pipe` 暴露原始流；`{ data }` 写入字节后关闭。 */
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string };

/** 有界内存收集，可选全量溢出文件。 */
export interface SubprocessCollect {
  maxBytes: number;
  spill?: { maxBytes: number };
}

/** stdout/stderr 处置：`pipe` 原始流；`inherit` 透传父描述符；对象为有界收集。 */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect;

/** 每流 stdio 处置（全显式，无默认值）。 */
export interface SubprocessStdio {
  stdin: SubprocessStdinMode;
  stdout: SubprocessOutputMode;
  stderr: SubprocessOutputMode;
}

/** 完整指定的 spawn 请求：`argv[0]` 为程序，从不 shell 解释。 */
export interface SubprocessSpawnSpec {
  argv: readonly string[];
  cwd: string;
  stdio: SubprocessStdio;
  /** SIGTERM→SIGKILL 升级与 drain 的宽限期（毫秒）。 */
  graceMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/** 一次已关闭子进程的退出事实（Node `close` 词汇）。 */
export interface SubprocessOutcome {
  exitCode: number | null;
  signal: string | null;
  /** 执行器自身超时（graceMs 到期 SIGTERM→SIGKILL）是首个终止原因。 */
  timedOut?: boolean;
}

/** 一次增量读取。 */
export interface SubprocessOutputRead {
  text: string;
  nextOffset: number;
  lossy: boolean;
  spillPath?: string;
}

/** 按偏移的增量读取。 */
export interface SubprocessOutputReader {
  readFrom(fromByte: number): SubprocessOutputRead;
}

/** collect 模式各流的偏移读取器。 */
export interface SubprocessCollectedOutputs {
  readonly stdout?: SubprocessOutputReader;
  readonly stderr?: SubprocessOutputReader;
}

/** 活子进程句柄：原始树根进程，退出后收集输出仍可读。 */
export interface SubprocessHandle {
  readonly pid: number;
  readonly collected: SubprocessCollectedOutputs;
  readonly done: Promise<SubprocessOutcome>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}

/** `ctx.subprocess` 能力接缝：可执行路径解析 + 受管子进程树启动。 */
export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor;
    subprocess: SubprocessRuntime;
  }
}
