/**
 * 宿主会话唤醒诊断（**仅测试开关下启用**，生产路径零副作用）。
 *
 * 真机缺陷取证用：把宿主会话每次 `agent/pre-step` 的「认领批次 → 归属判定 → 决定」
 * 打成一行机器可读记录，由 e2e 测试从 DSH 子进程 stderr 收集并落
 * `e2e/.artifacts/host-wakeups.txt`（见 `e2e/m8-host-wakeups.e2e.ts`）。
 *
 * **为什么走 stderr 而不是写文件**：本仓库 host 侧一律不直连 `node:fs`（对齐 DSH 的
 * `ctx.fs` 服务纪律），而 DSH 子进程的 stderr 已被 e2e harness 采集
 * （`DshServer.logSince/countSince`，mock LLM 的 `[e2e-mock] call#N` 走同一通道）。
 *
 * 开关：`SANDORE_WAKEUP_DIAG=1`。未设置时 `hostWakeupDiag()` 恒为 no-op（连字符串都不拼）。
 * @module @meiyukichan/dsh-sandore/workflow/src/wakeup-diag
 */

/** 诊断行前缀（e2e 侧按它过滤）。 */
export const WAKEUP_DIAG_PREFIX = '[sandore-wakeup]';

/** 诊断开关环境变量名。 */
export const WAKEUP_DIAG_ENV = 'SANDORE_WAKEUP_DIAG';

/** 一条唤醒诊断记录（机器可读；e2e 测试逐字段核对）。 */
export interface HostWakeupRecord {
  /** 宿主会话 id（≡ 实例 id ≡ 主代理 agent id）。 */
  readonly hostSessionId: string;
  /** 实例当时的状态（running/interacting/paused/…）。 */
  readonly instanceStatus: string;
  /** `agent/pre-step` 的 turn/step 位置（每次唤醒一个 turn）。 */
  readonly turn: number;
  readonly step: number;
  /** 认领批次里每条消息的来源与归属判定。 */
  readonly batch: readonly HostWakeupBatchEntry[];
  /** 最终决定：`park` 整批 park / `enter` 放行进模型 / `partial` 只摘掉本实例子代理的 / `pass` 无本实例消息。 */
  readonly decision: 'park' | 'enter' | 'partial' | 'pass';
}

/** 批次内单条消息的诊断条目。 */
export interface HostWakeupBatchEntry {
  /** `source.kind`（user / plugin / subagent-settled / agent-message / …）。 */
  readonly kind?: string;
  /** `source.senderSessionId`（子代理来源消息才带）。 */
  readonly senderSessionId?: string;
  /** 归属判定命中项：`executed`（executedSteps childId）/`paused`（暂停登记表）/`registry`（子会话登记表）/`live`（live 会话 header）/`persisted`（持久化 header）；未命中为 null。 */
  readonly attribution: string | null;
}

/**
 * 读环境变量（**不引用 `process` 标识符**：host 侧编译图不带 node 类型，且 host 包保持
 * 「不 import node 内置」的纪律；经 globalThis 结构化读取，浏览器侧自然得到 undefined）。
 * @param name - 环境变量名。
 * @returns 变量值，缺失时为 undefined。
 */
function readEnv(name: string): string | undefined {
  const scope = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return scope.process?.env?.[name];
}

/**
 * 是否启用唤醒诊断（每次调用都读 env：同一个 DSH 进程只读一次，开销可忽略）。
 * @returns 开启时为 true。
 */
export function wakeupDiagEnabled(): boolean {
  try {
    return readEnv(WAKEUP_DIAG_ENV) === '1';
  } catch {
    return false;
  }
}

/**
 * 输出一条唤醒诊断（未开启时 no-op；任何异常都吞掉，绝不影响引擎路径）。
 * @param record - 唤醒诊断记录。
 */
export function hostWakeupDiag(record: HostWakeupRecord): void {
  if (!wakeupDiagEnabled()) {
    return;
  }
  try {
    // 与 mock LLM 同通道（DSH 子进程 stderr → e2e harness 的日志采集）。
    console.error(`${WAKEUP_DIAG_PREFIX} ${JSON.stringify(record)}`);
  } catch {
    // 诊断失败绝不影响宿主唤醒判定。
  }
}
