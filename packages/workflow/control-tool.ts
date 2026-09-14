/**
 * sandore_workflow_control —— 工作流暂停/继续控制（架构决策 3）。
 *
 * `action:'pause'` 走既有暂停路径（interrupt 运行中 Step 子代理 → 主循环 parked）；
 * `action:'continue'` 的**机制由引擎按 Step 当前状态自动选择**（任务书明确要求）：
 * - Step `paused` → 继续**现有**子代理（followup 续跑，childId 不变）；
 * - Step `failed` → **重建**子代理（原 `retryStep(mode:'fork')` 语义，新 childId）。
 *
 * `scope` 省略 = `'all'`（全部可暂停/可继续的 Step）；`scope:'<stepId>'` 定点。
 * @module @meiyukichan/dsh-sandore/workflow/src/control-tool
 */
import { z } from 'zod';

import { SandoreError } from './errors.ts';
import type { WorkflowTaskState } from './schema.ts';
import type { SandoreToolEnvelope, SandoreToolExec, SandoreToolHost } from './tool-support.ts';
import {
  TOOL_OUTPUT,
  assertCallerIsTopLevel,
  assertNoUnknownKeys,
  errorEnvelope,
  executedStepIdOf,
  latestSegmentsByStep,
  losslessExecute,
  requireCallerSessionId,
} from './tool-support.ts';

/** 工具注册名。 */
export const WORKFLOW_CONTROL_TOOL_NAME = 'sandore_workflow_control';

/** `continue` 的缺省提示词（failed → 重建子代理时的重试消息）。 */
const DEFAULT_RETRY_MESSAGE = '请重试该步骤。';

/** 工具 parameters。 */
export const WORKFLOW_CONTROL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['pause', 'continue'],
      description:
        "pause=暂停（可随时恢复，子代理被 interrupt，已完成的 Step 不受影响）；" +
        'continue=继续/恢复（引擎按 Step 状态自动选择机制：paused → 继续现有子代理；failed → 重建子代理重试）。',
    },
    scope: {
      type: 'string',
      description:
        "范围：'all'（缺省——省略、显式 'all'、空串三者等价）或某个 stepId（只作用于该 Step；"
        + 'stepId 不存在时报 NODE_NOT_FOUND，不会静默当成「状态不可继续」）。',
    },
    message: {
      type: 'string',
      description: 'continue 时附带给子代理的提示词（paused → 续跑提示；failed → 重试要求）。',
    },
    instanceId: {
      type: 'string',
      description: '实例 id。省略时从调用会话反查该会话绑定的实例（推荐省略）。',
    },
  },
};

/** 工具描述（描述即契约）。 */
export const WORKFLOW_CONTROL_TOOL_DESCRIPTION = [
  'Pause or continue a sandore workflow instance.',
  '',
  "action: 'pause' interrupts every running step's subagent (in-flight step work is parked; completed steps are untouched); 'continue' resumes: a paused step continues in its EXISTING subagent session, a failed step is retried in a REBUILT subagent session (new child id). The engine picks the mechanism per step status — you do not choose it.",
  '',
  "scope: 'all' (default; omitting it, passing 'all', or passing '' are equivalent) or one stepId (an unknown stepId fails with NODE_NOT_FOUND). Targets are always resolved from each step's LATEST execution segment — a step whose latest segment is already running is NOT a continue target (older paused segments are history). message: optional guidance/retry prompt handed to the subagents.",
  '',
  'Result: ok:true means at least one target was acted on — check data.resumed / data.retried for which ones, and data.failures for per-step errors. When EVERY target failed (resumed and retried both empty but failures non-empty) the envelope is ok:false with error.code STEP_CONTROL_FAILED and the same data.failures. "nothing to continue" (no paused/failed step at all) is an INVALID_OPERATION error, not an empty success.',
  '',
  'instanceId may be omitted (resolved from this session).',
].join('\n');

/** 入参 zod。 */
export const WorkflowControlArgsSchema = z.object({
  action: z.enum(['pause', 'continue']),
  scope: z.string().optional(),
  message: z.string().optional(),
  instanceId: z.string().optional(),
});

export type WorkflowControlArgs = z.infer<typeof WorkflowControlArgsSchema>;

/** 可暂停的 Step 状态（与 lifecycle-manager 同口径：running/interacting，且非 shell）。 */
const PAUSABLE_STATUSES: ReadonlySet<string> = new Set(['running', 'interacting']);
/** 可继续的 Step 状态（paused → 继续现有子代理；failed → 重建子代理）。 */
const CONTINUABLE_STATUSES: ReadonlySet<string> = new Set(['paused', 'failed']);

/** 解析目标实例（入参 instanceId 优先；否则从调用会话反查）。 */
function resolveInstanceId(host: SandoreToolHost, args: WorkflowControlArgs, exec: SandoreToolExec): string {
  if (args.instanceId !== undefined && args.instanceId !== '') {
    return args.instanceId;
  }
  const hostSessionId = requireCallerSessionId(exec, WORKFLOW_CONTROL_TOOL_NAME);
  const instanceId = host.findInstanceIdByHostSession(hostSessionId);
  if (instanceId === undefined) {
    throw new SandoreError(
      `no sandore workflow instance is bound to session '${hostSessionId}' (pass instanceId explicitly to control another instance)`,
      'NODE_NOT_FOUND',
    );
  }
  return instanceId;
}

/** 读状态（内存优先 → 持久化兜底）。 */
function readState(host: SandoreToolHost, instanceId: string): WorkflowTaskState {
  const live = host.getInstanceState(instanceId);
  if (live !== undefined) {
    return live;
  }
  const persisted = host.persistence()?.state.get(instanceId);
  if (persisted === undefined) {
    throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
  }
  return persisted;
}

/** 本工具的可用参数名（未知键报错时列出；由 zod shape 派生）。 */
const CONTROL_TOOL_ALLOWED_KEYS = Object.keys(WorkflowControlArgsSchema.shape);

/**
 * 展开 scope → 目标 Step id 列表。
 *
 * scope 省略 / `'all'` / `''`：按 action 收集「**最新执行段**处于对应状态的 Step」
 * （pause → running/interacting；continue → paused/failed）。**必须按最新段判定**：
 * 段模型下同一步骤可有多段（暂停续跑/重试/ask 续问），旧段状态永久冻结在历史值上，
 * 用「任意段匹配」会选中一个**最新段已 running** 的 step，随后又被状态判定拒绝 ——
 * 同一次调用自相矛盾（审计实测：0/1 段 paused + 2 段 running 时 continue 选中它又报
 * 「running 既非 paused 也非 failed」）。
 *
 * 显式 stepId：原样单点（存在性由 {@link doContinue} / 引擎侧方法校验）。
 */
export function expandScope(state: WorkflowTaskState, action: 'pause' | 'continue', scope: string | undefined): string[] {
  if (scope !== undefined && scope !== '' && scope !== 'all') {
    return [scope];
  }
  const wanted = action === 'pause' ? PAUSABLE_STATUSES : CONTINUABLE_STATUSES;
  return [...latestSegmentsByStep(state.executedSteps).values()]
    .filter(step => wanted.has(step.status))
    .map(step => executedStepIdOf(step));
}

/** execute 入口。 */
export async function executeControlTool(
  host: SandoreToolHost,
  raw: unknown,
  exec: SandoreToolExec,
): Promise<SandoreToolEnvelope> {
  let action: string | undefined;
  try {
    const args = WorkflowControlArgsSchema.parse(raw);
    action = args.action;
    assertNoUnknownKeys(raw, CONTROL_TOOL_ALLOWED_KEYS, WORKFLOW_CONTROL_TOOL_NAME);
    assertCallerIsTopLevel(exec, WORKFLOW_CONTROL_TOOL_NAME);
    const instanceId = resolveInstanceId(host, args, exec);
    const state = readState(host, instanceId);
    const targets = expandScope(state, args.action, args.scope);
    if (targets.length === 0) {
      throw new SandoreError(
        args.action === 'pause'
          ? 'no running step to pause（没有 running/interacting 的 Step；shell Step 不可暂停）'
          : 'nothing to continue（没有 paused/failed 的 Step）',
        'INVALID_OPERATION',
      );
    }
    if (args.action === 'pause') {
      return { ok: true, action, data: { ...(await doPause(host, instanceId, targets, args.scope)) } };
    }
    // continue 的三态信封由 doContinue 决定（全失败 → ok:false，见其文档）。
    return await doContinue(host, instanceId, state, targets, args.message);
  } catch (err) {
    // 本工具的 zod 面全是入参 → 参数问题一律 INVALID_OPERATION（见 tool-support.errorEnvelope）。
    return errorEnvelope(action, err, 'INVALID_OPERATION');
  }
}

/** pause：scope=all 用引擎的整实例暂停（走 lifecycle.pauseAllSteps 语义）；定点用 pauseStep。 */
async function doPause(
  host: SandoreToolHost,
  instanceId: string,
  targets: readonly string[],
  scope: string | undefined,
): Promise<Record<string, unknown>> {
  if (scope === undefined || scope === '' || scope === 'all') {
    await host.pauseAllSteps(instanceId);
    return { instanceId, action: 'pause', scope: 'all', paused: [...targets] };
  }
  const stepId = targets[0]!;
  await host.pauseStep(instanceId, stepId);
  return { instanceId, action: 'pause', scope: stepId, paused: [stepId] };
}

/**
 * continue：**按 Step 当前状态自动选机制**（任务书决策 3 的核心语义）。
 *
 * - paused → `resumeStep`（followup 现有子代理，childId 不变）；
 * - failed → `retryStep(mode:'fork')`（重建子代理，新 childId）。
 *
 * 状态一律取**每个 stepId 的最新执行段**（与 {@link expandScope} 同口径 —— 两套口径
 * 会让「选中的目标」被自己判成不可继续，审计实测的自相矛盾即此）。
 *
 * scope=all 且全部目标都是 paused 时走引擎的 `resumeAllSteps`（一次性广播，语义与 UI
 * 的「全部恢复」一致）；混合场景逐步处理。
 *
 * 信封三态（P1，与 `send_message` 对齐）：
 * - 部分/全部成功 → `ok:true`，`data.resumed`/`data.retried` 记录生效目标，`data.failures`
 *   记部分失败；
 * - **全部目标失败**（resumed/retried 皆空且 failures 非空）→ `ok:false` +
 *   `error.code='STEP_CONTROL_FAILED'`（同一个 `data.failures`，模型只看 ok 也不会误报成功）；
 * - 显式 stepId **不存在** → 抛 `NODE_NOT_FOUND`（先判存在性，不再报成「状态不可继续」）。
 */
async function doContinue(
  host: SandoreToolHost,
  instanceId: string,
  state: WorkflowTaskState,
  targets: readonly string[],
  message: string | undefined,
): Promise<SandoreToolEnvelope> {
  const latest = latestSegmentsByStep(state.executedSteps);
  // 先判存在性：显式 scope 指向不存在的 stepId 时报 NODE_NOT_FOUND（旧实现把「不存在」
  // 与「状态不可继续」混成 `status 'unknown'`，模型无法区分该改参数还是该换动作）。
  const missing = targets.filter(stepId => !latest.has(stepId));
  if (missing.length > 0) {
    throw new SandoreError(
      `step '${missing[0]}' not found in instance '${instanceId}'`
      + '（用 sandore_workflow_status detail=steps 查看该实例已执行的 Step id）',
      'NODE_NOT_FOUND',
    );
  }
  const statusOf = new Map([...latest].map(([stepId, step]) => [stepId, step.status]));
  const paused = targets.filter(stepId => statusOf.get(stepId) === 'paused');
  const failed = targets.filter(stepId => statusOf.get(stepId) === 'failed');
  const other = targets.filter(stepId => !paused.includes(stepId) && !failed.includes(stepId));
  const resumed: string[] = [];
  const retried: string[] = [];
  const failures: Array<{ stepId: string; error: string }> = [];

  if (paused.length > 0 && failed.length === 0 && other.length === 0) {
    // 全部目标都是 paused：走引擎的整实例恢复（广播语义 + 唤醒主循环等待者）。
    await host.resumeAllSteps(instanceId, message);
    resumed.push(...paused);
  } else {
    for (const stepId of paused) {
      try {
        await host.resumeStep(instanceId, stepId, message);
        resumed.push(stepId);
      } catch (err) {
        failures.push({ stepId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  for (const stepId of failed) {
    try {
      await host.retryStep(instanceId, stepId, 'fork', message ?? DEFAULT_RETRY_MESSAGE);
      retried.push(stepId);
    } catch (err) {
      failures.push({ stepId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const stepId of other) {
    failures.push({
      stepId,
      error: `step status '${statusOf.get(stepId) ?? 'unknown'}' is neither paused nor failed; continue only resumes paused steps or rebuilds failed ones`,
    });
  }
  const data: Record<string, unknown> = {
    instanceId,
    action: 'continue',
    resumed,
    retried,
    ...(failures.length === 0 ? {} : { failures }),
  };
  if (resumed.length === 0 && retried.length === 0 && failures.length > 0) {
    const reason = failures.map(item => `${item.stepId}: ${item.error}`).join('; ');
    return {
      ok: false,
      action: 'continue',
      reason,
      error: { code: 'STEP_CONTROL_FAILED', message: reason },
      data,
    };
  }
  return { ok: true, action: 'continue', data };
}

/** 注册（`tools` 服务缺失时静默跳过）。 */
export function registerGlobalControlTool(ctx: { get(name: string): unknown }, host: SandoreToolHost): () => void {
  const tools = ctx.get('tools') as { register(tool: unknown): () => void } | undefined;
  if (tools === undefined) {
    return () => {};
  }
  return tools.register({
    name: WORKFLOW_CONTROL_TOOL_NAME,
    description: WORKFLOW_CONTROL_TOOL_DESCRIPTION,
    parameters: WORKFLOW_CONTROL_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: (args: unknown, exec: unknown) => losslessExecute(() => executeControlTool(host, args, exec as SandoreToolExec)),
  });
}
