/**
 * sandore_workflow_send_message —— 给工作流 Step 子代理发消息（架构决策 3）。
 *
 * 单点=长度 1 的 targets，批量=多元素；`'all'` 表示广播给当前 running/interacting
 * 的 Step。每条消息经引擎 `sendStepMessage` 投递到**子代理会话**并单发
 * `sandore/step-message`（投递凭据 = 本工具返回的 `data.delivered` + 该事件）；
 * **不写 `state.userMessages`**——消息本身已经是该 Step 面板里的「step agent 消息」，
 * discussion 页只展示 step agent 消息与主代理消息。
 * @module @meiyukichan/dsh-sandore/workflow/src/message-tool
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
export const WORKFLOW_MESSAGE_TOOL_NAME = 'sandore_workflow_send_message';

/** 工具 parameters。 */
export const WORKFLOW_MESSAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['targets', 'message'],
  properties: {
    targets: {
      type: 'array',
      items: { type: 'string' },
      description:
        "目标 Step：" +
        "['all'] 广播给当前正在执行的 Step；['<stepId>'] 定点单个 Step；多元素批量（如 ['step-a','step-b']）。" +
        '（Step id 见 sandore_workflow_status detail=steps。）',
    },
    message: {
      type: 'string',
      description: '要发给子代理的消息（作为用户消息追加到该 Step 子代理会话并驱动它继续）。',
    },
    instanceId: {
      type: 'string',
      description: '实例 id。省略时从调用会话反查该会话绑定的实例（推荐省略）。',
    },
  },
};

/** 工具描述（描述即契约）。 */
export const WORKFLOW_MESSAGE_TOOL_DESCRIPTION = [
  'Send a message to the subagent session(s) running a sandore workflow step — use it to steer a step that is drifting, or to hand it extra context.',
  '',
  "targets: ['all'] broadcasts to every currently running/interacting step; ['<stepId>'] targets one step; multiple elements send to each. Both forms share the SAME gate: only subagent steps (prompt/agent/skill/mcp) whose LATEST execution segment is running/interacting can receive a message. A paused/failed/completed step, a shell step, or a terminal instance is rejected with the current status and the suggested action (e.g. paused → run sandore_workflow_control {action:'continue'} first).",
  '',
  'Per-target results: a fully successful call returns {delivered}; a partial call returns ok:true with data.delivered + data.failures; when EVERY target fails the envelope is ok:false with error.code STEP_DELIVERY_FAILED and the same data.failures (no separate warnings — the structured failures are the report).',
  '',
  'instanceId may be omitted (resolved from this session).',
].join('\n');

/** 入参 zod。 */
export const WorkflowMessageArgsSchema = z.object({
  targets: z.array(z.string()).min(1),
  message: z.string().min(1),
  instanceId: z.string().optional(),
});

export type WorkflowMessageArgs = z.infer<typeof WorkflowMessageArgsSchema>;

/** 本工具的可用参数名（未知键报错时列出；由 zod shape 派生）。 */
const MESSAGE_TOOL_ALLOWED_KEYS = Object.keys(WorkflowMessageArgsSchema.shape);

/** 可接收消息的 Step 状态（与 lifecycle-manager 的可暂停集合同口径）。 */
const MESSAGEABLE_STATUSES: ReadonlySet<string> = new Set(['running', 'interacting']);

/** 解析目标实例（入参 instanceId 优先；否则从调用会话反查）。 */
function resolveInstanceId(host: SandoreToolHost, args: WorkflowMessageArgs, exec: SandoreToolExec): string {
  if (args.instanceId !== undefined && args.instanceId !== '') {
    return args.instanceId;
  }
  const hostSessionId = requireCallerSessionId(exec, WORKFLOW_MESSAGE_TOOL_NAME);
  const instanceId = host.findInstanceIdByHostSession(hostSessionId);
  if (instanceId === undefined) {
    throw new SandoreError(
      `no sandore workflow instance is bound to session '${hostSessionId}' (pass instanceId explicitly to steer another instance)`,
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

/**
 * 展开 targets → 去重后的 Step id 列表。
 *
 * 可投递性按**最新执行段**判定（与引擎 `sendStepMessage` 的门槛同一口径，见
 * tool-support.latestSegmentsByStep）：同一步骤多次执行时旧段的状态是历史值，
 * 用「任意段匹配」会把最新段已 running 之外的状态算进来（审计实测的口径分歧）。
 *
 * `'all'` 展开为当前 running/interacting 的**子代理** Step（shell Step 无子代理会话，
 * 不可收消息——引擎会拒绝，故此处先行过滤，避免批量里被一步拖垮）。
 * 显式 stepId 不做过滤：交给引擎给出一致的门槛错误（含当前状态 + 建议动作），
 * 这样两条路径的**判定规则**相同（`'all'` 只是多了一层「广播范围」筛选）。
 */
export function expandTargets(state: WorkflowTaskState, targets: readonly string[]): string[] {
  const wantsAll = targets.includes('all');
  const explicit = targets.filter(target => target !== 'all');
  const active = [...latestSegmentsByStep(state.executedSteps).values()]
    .filter(step => MESSAGEABLE_STATUSES.has(step.status))
    .map(step => executedStepIdOf(step));
  const expanded = wantsAll ? [...active, ...explicit] : explicit;
  return [...new Set(expanded)];
}

/** execute 入口：逐目标投递，串行收集每个目标的成败（不因单个目标失败中止其余）。 */
export async function executeMessageTool(
  host: SandoreToolHost,
  raw: unknown,
  exec: SandoreToolExec,
): Promise<SandoreToolEnvelope> {
  const action = 'send_message';
  try {
    const args = WorkflowMessageArgsSchema.parse(raw);
    assertNoUnknownKeys(raw, MESSAGE_TOOL_ALLOWED_KEYS, WORKFLOW_MESSAGE_TOOL_NAME);
    assertCallerIsTopLevel(exec, WORKFLOW_MESSAGE_TOOL_NAME);
    const instanceId = resolveInstanceId(host, args, exec);
    const state = readState(host, instanceId);
    const targets = expandTargets(state, args.targets);
    if (targets.length === 0) {
      throw new SandoreError(
        "no messageable step: targets expanded to nothing (只有 running/interacting 的子代理 Step 可收消息；"
        + '用 sandore_workflow_status detail=steps 查看当前 Step 状态)',
        'INVALID_OPERATION',
      );
    }
    const delivered: string[] = [];
    const failures: Array<{ stepId: string; error: string }> = [];
    for (const stepId of targets) {
      try {
        await host.sendStepMessage(instanceId, stepId, args.message);
        delivered.push(stepId);
      } catch (err) {
        failures.push({ stepId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (delivered.length === 0) {
      return {
        ok: false,
        action,
        reason: failures.map(item => `${item.stepId}: ${item.error}`).join('; '),
        error: { code: 'STEP_DELIVERY_FAILED', message: failures.map(item => `${item.stepId}: ${item.error}`).join('; ') },
        data: { instanceId, delivered, failures },
      };
    }
    return {
      ok: true,
      action,
      // 部分失败：ok:true + 结构化 failures（S4：不再同时给 warnings —— 同一信息不重复两份）。
      data: { instanceId, delivered, ...(failures.length === 0 ? {} : { failures }) },
    };
  } catch (err) {
    // 本工具的 zod 面全是入参 → 参数问题一律 INVALID_OPERATION（见 tool-support.errorEnvelope）。
    return errorEnvelope(action, err, 'INVALID_OPERATION');
  }
}

/** 注册（`tools` 服务缺失时静默跳过）。 */
export function registerGlobalMessageTool(ctx: { get(name: string): unknown }, host: SandoreToolHost): () => void {
  const tools = ctx.get('tools') as { register(tool: unknown): () => void } | undefined;
  if (tools === undefined) {
    return () => {};
  }
  return tools.register({
    name: WORKFLOW_MESSAGE_TOOL_NAME,
    description: WORKFLOW_MESSAGE_TOOL_DESCRIPTION,
    parameters: WORKFLOW_MESSAGE_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: (args: unknown, exec: unknown) => losslessExecute(() => executeMessageTool(host, args, exec as SandoreToolExec)),
  });
}
