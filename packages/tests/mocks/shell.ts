/**
 * 内存 mock shell（测试专用，非发布面）。
 *
 * 提供 `resolve`/`run` 等价语义：`resolve` 记录请求并委托 `resolveHandler`，
 * `run` 记录规格并委托 `runHandler`。以 `ctx.provide('shell', …)` 注入。
 * @module dsh-sandore/workflow/tests/mocks/shell
 */
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellRunResult,
} from '../../workflow/shell.ts';

/** 生成一次成功（exitCode 0）的 shell 运行结果。 */
export function successResult(spec: ShellExecSpec, stdout = ''): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
  };
}

/** 内存 mock shell：记录 resolve/run 调用并可注入行为。 */
export class FakeShell {
  readonly requests: ShellExecRequest[] = [];
  readonly specs: ShellExecSpec[] = [];
  resolveHandler: (request: ShellExecRequest) => ShellExecSpec = defaultResolve;
  runHandler: (spec: ShellExecSpec) => Promise<ShellRunResult> = async spec => successResult(spec);

  resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request);
    return this.resolveHandler(request);
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec);
    return this.runHandler(spec);
  }

  start(spec: ShellExecSpec): unknown {
    throw new Error(`FakeShell.start(${spec.command}) is not implemented`);
  }
}

/** 默认 resolve：补全 workdir/timeoutMs/stdoutMaxBytes。 */
function defaultResolve(request: ShellExecRequest): ShellExecSpec {
  return {
    command: request.command,
    workdir: request.workdir ?? '/tmp',
    timeoutMs: request.timeoutMs ?? 60000,
    stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    ...(request.env === undefined ? {} : { env: request.env }),
  };
}
