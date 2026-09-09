/**
 * 内存 mock subprocess（测试专用，非发布面）。
 *
 * 提供 `resolveExecutable`/`spawn` 等价语义：`resolveExecutable` 记录命令并返回规范
 * 路径，`spawn` 记录规格并返回可注入行为的内存句柄。以 `ctx.provide('subprocess', …)`
 * 注入。
 * @module @meiyukichan/dsh-sandore/workflow/tests/mocks/subprocess
 */
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '../../workflow/shell.ts';

/** 生成一次成功（exitCode 0）的子进程结果。 */
export function successOutcome(): SubprocessOutcome {
  return { exitCode: 0, signal: null };
}

/** 内存子进程句柄：`done` 由 `outcomeHandler` 决定，`terminate`/`waitForExit` 记录调用。 */
export class FakeSubprocessHandle implements SubprocessHandle {
  readonly pid: number;
  readonly collected: SubprocessHandle['collected'];
  readonly done: Promise<SubprocessOutcome>;
  terminated = false;

  constructor(pid: number, outcomeHandler: () => SubprocessOutcome = successOutcome) {
    this.pid = pid;
    this.collected = {};
    this.done = Promise.resolve(outcomeHandler());
  }

  terminate(): void {
    this.terminated = true;
  }

  async waitForExit(): Promise<boolean> {
    return true;
  }
}

/** 内存 mock subprocess：记录 resolve/spawn 调用并可注入行为。 */
export class FakeSubprocess implements SubprocessRuntime {
  readonly resolved: string[] = [];
  readonly specs: SubprocessSpawnSpec[] = [];
  resolveHandler: (command: string) => string = command => `/usr/bin/${command}`;
  outcomeHandler: () => SubprocessOutcome = successOutcome;

  async resolveExecutable(command: string): Promise<string> {
    this.resolved.push(command);
    return this.resolveHandler(command);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec);
    return new FakeSubprocessHandle(this.specs.length, this.outcomeHandler);
  }
}
