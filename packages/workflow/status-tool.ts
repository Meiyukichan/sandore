/**
 * sandore_workflow_status —— 工作流实例状态查询（架构决策 3）。
 *
 * 从原 `sandore_workflow` 的 `get-state` action 迁出（原工具不再保留运行面 action，
 * 避免两套入口），并按「一次问一件事」重设计为 `detail` 四档：
 * - `summary`（默认）：实例概览（状态/阶段/进度/待答交互）；
 * - `steps`：已执行 Step/执行段摘要行（`limit` 封顶）；
 * - `step`：单个 Step 的最新执行段详情（需 `stepId`；含产物、收尾阶段、重试历史）；
 * - `messages`：会话消息（带 `stepId` = 该 Step 子代理会话消息尾部；不带 = 实例级
 *   用户消息尾部 + 各 Step 消息计数）。
 *
 * `instanceId` 省略时**从调用会话反查**该会话绑定的实例（恒等式下即会话 id），
 * 宿主主代理无需自己记 instanceId。
 * @module @meiyukichan/dsh-sandore/workflow/src/status-tool
 */
import { z } from 'zod';

import { SandoreError } from './errors.ts';
import type { SessionMessage, WorkflowTaskState } from './schema.ts';
import type { SandoreToolEnvelope, SandoreToolExec, SandoreToolHost } from './tool-support.ts';
import {
  TOOL_OUTPUT,
  assertCallerIsTopLevel,
  assertNoUnknownKeys,
  errorEnvelope,
  executedStepIdOf,
  losslessExecute,
  requireCallerSessionId,
  toLosslessJsonValue,
  truncateText,
} from './tool-support.ts';

/** 工具注册名。 */
export const WORKFLOW_STATUS_TOOL_NAME = 'sandore_workflow_status';

/** step 输出预览上限（字符）。 */
const OUTPUT_PREVIEW_CHARS = 2000;
/** `messages` 的缺省返回条数（尾部）。 */
const DEFAULT_MESSAGE_LIMIT = 20;
/** `messages` 的条数上限（防一次性拖入整段历史）。 */
const MAX_MESSAGE_LIMIT = 200;
/** `steps` 的缺省返回行数上限。 */
const DEFAULT_STEP_LIMIT = 50;

/** 工具 parameters。 */
export const WORKFLOW_STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['detail'],
  properties: {
    detail: {
      type: 'string',
      enum: ['summary', 'steps', 'step', 'messages'],
      description:
        '查询粒度：summary=实例概览（默认推荐）；steps=全部执行段摘要（**按执行段计数**：同一 stepId '
        + '多次执行会有多行）；step=单个 Step 最新执行段详情（需 stepId）；messages=会话消息尾部'
        + '（带 stepId 看该 Step 子代理会话）。',
    },
    instanceId: {
      type: 'string',
      description: '实例 id。省略时从调用会话反查该会话绑定的实例（推荐省略）。',
    },
    stepId: {
      type: 'string',
      description: "Step id（detail='step' 必填；detail='messages' 可选——传则看该 Step 子代理会话消息）。",
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_MESSAGE_LIMIT,
      description:
        `返回条数上限（steps/messages 共用；合法区间 1-${MAX_MESSAGE_LIMIT}）：`
        + `steps 缺省 ${DEFAULT_STEP_LIMIT}（取尾部 N 段，超出时返回 truncated:true）；`
        + `messages 缺省 ${DEFAULT_MESSAGE_LIMIT}（取尾部 N 条）。`,
    },
  },
};

/** 工具描述（描述即契约）。 */
export const WORKFLOW_STATUS_TOOL_DESCRIPTION = [
  'Read the state of a sandore workflow instance (read-only; works in every status).',
  '',
  "detail: 'summary' = status/stage/progress/pending interactions; 'steps' = every executed step SEGMENT row "
  + '(counting is per segment: one step that ran several times has several rows, so the payload carries '
  + 'segmentCount + distinctStepCount); \'step\' = one step\'s latest segment detail (requires stepId); '
  + "'messages' = session messages (with stepId: that step subagent session; without: instance-level user messages + per-step counts).",
  '',
  `limit: optional row cap for 'steps'/'messages' (1-${MAX_MESSAGE_LIMIT}); defaults ${DEFAULT_STEP_LIMIT} rows for 'steps' and ${DEFAULT_MESSAGE_LIMIT} messages.`,
  '',
  'instanceId may be omitted: the instance bound to THIS session is resolved automatically. Pass it only to inspect another instance.',
].join('\n');

/** 入参 zod。 */
export const WorkflowStatusArgsSchema = z.object({
  detail: z.enum(['summary', 'steps', 'step', 'messages']),
  instanceId: z.string().optional(),
  stepId: z.string().optional(),
  limit: z.number().int().positive().max(MAX_MESSAGE_LIMIT).optional(),
});

export type WorkflowStatusArgs = z.infer<typeof WorkflowStatusArgsSchema>;

/** 本工具的可用参数名（未知键报错时列出；由 zod shape 派生）。 */
const STATUS_TOOL_ALLOWED_KEYS = Object.keys(WorkflowStatusArgsSchema.shape);

/** 跨字段硬约束：detail='step' 必须有 stepId。 */
function assertStatusArgs(args: WorkflowStatusArgs): void {
  if (args.detail === 'step' && (args.stepId === undefined || args.stepId === '')) {
    throw new SandoreError("detail='step' 必须携带 stepId", 'INVALID_OPERATION');
  }
}

/** 已执行段行类型（状态快照元素）。 */
type ExecutedStepRow = WorkflowTaskState['executedSteps'][number];

/** executedSteps 摘要行。 */
function stepSummaryRow(step: ExecutedStepRow): Record<string, unknown> {
  return {
    stageId: step.stageId,
    stepId: step.stepId ?? step.id,
    name: step.name,
    status: step.status,
    ...(step.attemptIndex === undefined ? {} : { attemptIndex: step.attemptIndex }),
    ...(step.loopIteration === undefined ? {} : { loopIteration: step.loopIteration }),
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.updatedAt === undefined ? {} : { updatedAt: step.updatedAt }),
    ...(step.error === undefined ? {} : { error: step.error }),
    // `sessionMeta` 存在 ≠ 有子会话：shell 步骤（parallel1 之类）是 synthetic 段，
    // 只有 `{synthetic:true, command:'shell'}`，**没有 childId**。此处若写成
    // `sessionMeta.childId` 就会产出值为 undefined 的键 → 整个工具返回值不再是
    // lossless JSON → DSH 直接判 `invalid output`（真机复现，见 tool-support 的说明）。
    ...(step.sessionMeta?.childId === undefined ? {} : { childSessionId: step.sessionMeta.childId }),
    ...(step.finalizeMeta?.currentPhase === undefined ? {} : { phase: step.finalizeMeta.currentPhase }),
  };
}

/** 执行段比较（createdAt + attemptIndex 键序，取最新段用）。 */
function segmentNewerThan(candidate: ExecutedStepRow, baseline: ExecutedStepRow | undefined): boolean {
  if (baseline === undefined) return true;
  const candidateKey = `${candidate.createdAt ?? ''}#${candidate.attemptIndex ?? 0}`;
  const baselineKey = `${baseline.createdAt ?? ''}#${baseline.attemptIndex ?? 0}`;
  return candidateKey >= baselineKey;
}

/** ContentBlock[] 的文本预览（拼接 text 块后截断）。 */
function outputPreview(output: ExecutedStepRow['output'], maxChars: number): { text: string; truncated: boolean } | undefined {
  if (output === undefined) return undefined;
  const text = output
    .map((block: unknown) => (block !== null && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter((part: string) => part !== '')
    .join('\n');
  return truncateText(text, maxChars);
}

/** 解析目标实例（入参 instanceId 优先；否则从调用会话反查）。 */
function resolveInstanceId(host: SandoreToolHost, args: WorkflowStatusArgs, exec: SandoreToolExec): string {
  if (args.instanceId !== undefined && args.instanceId !== '') {
    return args.instanceId;
  }
  const hostSessionId = requireCallerSessionId(exec, WORKFLOW_STATUS_TOOL_NAME);
  const instanceId = host.findInstanceIdByHostSession(hostSessionId);
  if (instanceId === undefined) {
    throw new SandoreError(
      `no sandore workflow instance is bound to session '${hostSessionId}' (pass instanceId explicitly to inspect another instance)`,
      'NODE_NOT_FOUND',
    );
  }
  return instanceId;
}

/** 读实例状态快照（内存优先——收尾中间态立即可见；持久化兜底）。 */
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
 * 读取期由 `hydrateStateMessages` 回填的会话消息行（**不在持久化 schema 里**）。
 *
 * `sessionMessages` 已从 state 剥离（实测占 state 41%–54%），只在 `step`/`messages`
 * detail 的读取路径上按需从子代理会话现算，故用结构收窄读它。
 * @param step - 执行段。
 * @returns 消息行数组（未回填时为 undefined）。
 */
function hydratedMessagesOf(step: ExecutedStepRow): readonly SessionMessage[] | undefined {
  return (step as { sessionMessages?: readonly SessionMessage[] }).sessionMessages;
}

/** execute 入口。 */
export async function executeStatusTool(
  host: SandoreToolHost,
  raw: unknown,
  exec: SandoreToolExec,
): Promise<SandoreToolEnvelope> {
  const action = 'status';
  try {
    const args = WorkflowStatusArgsSchema.parse(raw);
    assertNoUnknownKeys(raw, STATUS_TOOL_ALLOWED_KEYS, WORKFLOW_STATUS_TOOL_NAME);
    assertCallerIsTopLevel(exec, WORKFLOW_STATUS_TOOL_NAME);
    assertStatusArgs(args);
    const instanceId = resolveInstanceId(host, args, exec);
    const state = readState(host, instanceId);
    // `sessionMessages` 不再持久化（实测占 state 的 41%–54%）：本工具的 `step`/`messages`
    // detail 需要它时**按需从子代理会话现算**（与 `getInstanceState` RPC 同源）。
    const hydrated = args.detail === 'step' || args.detail === 'messages'
      ? await host.hydrateStateMessages(state)
      : state;
    return { ok: true, action, data: { ...(doStatus(hydrated, instanceId, args)) } };
  } catch (err) {
    // 本工具的 zod 面全是入参 → 参数问题一律 INVALID_OPERATION（见 tool-support.errorEnvelope）。
    return errorEnvelope(action, err, 'INVALID_OPERATION');
  }
}

/** 按 detail 投影（纯函数，便于单测）。 */
function doStatus(state: WorkflowTaskState, instanceId: string, args: WorkflowStatusArgs): Record<string, unknown> {
  switch (args.detail) {
    case 'steps': {
      const limit = args.limit ?? DEFAULT_STEP_LIMIT;
      const rows = state.executedSteps.map(row => stepSummaryRow(row));
      return {
        instanceId,
        workflowId: state.workflowId,
        status: state.status,
        // 段模型口径（P5）：`steps[]` 是**执行段**行，同一 stepId 多段就多行。故计数分两个：
        // segmentCount = 段数（= rows.length，旧字段名 stepCount 会被读成「步骤数」）；
        // distinctStepCount = 去重后的 step 数（模型真正关心的「有几个步骤」）。
        segmentCount: rows.length,
        distinctStepCount: new Set(state.executedSteps.map(step => executedStepIdOf(step))).size,
        steps: rows.slice(-limit),
        ...(rows.length > limit ? { truncated: true, returnedCount: Math.min(limit, rows.length) } : {}),
      };
    }
    case 'step':
      return stepDetail(state, instanceId, args.stepId!);
    case 'messages':
      return messagesDetail(state, instanceId, args);
    case 'summary':
    default:
      return summaryDetail(state, instanceId);
  }
}

/** 实例概览。 */
function summaryDetail(state: WorkflowTaskState, instanceId: string): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  for (const step of state.executedSteps) {
    const key = step.status;
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return {
    instanceId,
    workflowId: state.workflowId,
    ...(state.workflowName === undefined ? {} : { workflowName: state.workflowName }),
    status: state.status,
    originalInput: state.originalInput,
    currentStageId: state.currentStageId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    stageInfos: state.stageInfos,
    segmentCounts: byStatus,
    pendingQueue: state.pendingQueue,
    pendingInteractions: state.pendingInteractions
      .filter(entry => entry.status === 'pending')
      .map(entry => ({ id: entry.id, kind: entry.kind, stageId: entry.stageId, stepId: entry.stepId, requestId: entry.requestId })),
    ...(state.executedSteps.filter(step => step.status === 'failed').length === 0
      ? {}
      : {
        failedSteps: state.executedSteps
          .filter(step => step.status === 'failed')
          .map(step => ({ stepId: step.stepId ?? step.id, name: step.name, error: step.error })),
      }),
  };
}

/** 单 Step 详情（最新执行段；含全部段摘要与产物）。 */
function stepDetail(state: WorkflowTaskState, instanceId: string, stepId: string): Record<string, unknown> {
  const segments = state.executedSteps.filter(step => (step.stepId ?? step.id) === stepId);
  if (segments.length === 0) {
    throw new SandoreError(`step '${stepId}' has no executed segments in instance '${instanceId}'`, 'NODE_NOT_FOUND');
  }
  let latest: ExecutedStepRow | undefined;
  for (const segment of segments) {
    if (segmentNewerThan(segment, latest)) latest = segment;
  }
  const step = latest!;
  const preview = outputPreview(step.output, OUTPUT_PREVIEW_CHARS);
  return {
    instanceId,
    workflowId: state.workflowId,
    stepId,
    segmentCount: segments.length,
    segments: segments.map(row => stepSummaryRow(row)),
    latest: {
      ...stepSummaryRow(step),
      ...(preview === undefined ? {} : { outputPreview: preview }),
      ...(step.artifacts === undefined ? {} : { artifacts: step.artifacts }),
      ...(hydratedMessagesOf(step) === undefined ? {} : { sessionMessagesCount: hydratedMessagesOf(step)!.length }),
      // 四个 meta 都是**引擎内部结构**（可选字段多、shell 段还可能整段缺 childId）：
      // 原样透传会把值为 undefined 的键带进工具返回值（DSH 判非法），故统一过一遍
      // lossless 规整（丢 undefined 键、Date/Error 降级）。
      ...metaField('sessionMeta', step.sessionMeta),
      ...metaField('finalizeMeta', step.finalizeMeta),
      ...metaField('branchMeta', step.branchMeta),
      ...metaField('loopMeta', step.loopMeta),
      ...metaField('retryHistory', step.retryHistory),
      ...(step.parentSessionId === undefined ? {} : { parentSessionId: step.parentSessionId }),
      ...(step.pausedAt === undefined ? {} : { pausedAt: step.pausedAt }),
    },
  };
}

/** 可选 meta 字段的 lossless 透传（缺省不输出；有值则规整后再输出）。 */
function metaField(key: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  return { [key]: toLosslessJsonValue(value) };
}

/** 会话消息（带 stepId：该 Step 子代理会话尾部；不带：实例级用户消息 + 各 Step 计数）。 */
function messagesDetail(state: WorkflowTaskState, instanceId: string, args: WorkflowStatusArgs): Record<string, unknown> {
  const limit = args.limit ?? DEFAULT_MESSAGE_LIMIT;
  if (args.stepId !== undefined && args.stepId !== '') {
    const segments = state.executedSteps.filter(step => (step.stepId ?? step.id) === args.stepId);
    if (segments.length === 0) {
      throw new SandoreError(`step '${args.stepId}' has no executed segments in instance '${instanceId}'`, 'NODE_NOT_FOUND');
    }
    let latest: ExecutedStepRow | undefined;
    for (const segment of segments) {
      if (segmentNewerThan(segment, latest)) latest = segment;
    }
    const messages = hydratedMessagesOf(latest!) ?? [];
    return {
      instanceId,
      stepId: args.stepId,
      childSessionId: latest!.sessionMeta?.childId,
      total: messages.length,
      messages: messages.slice(-limit),
    };
  }
  // 实例级「用户消息」：**现在只含真实用户输入**（makeInitialState 的 kind:'input' =
  // 原始需求）。恢复/重试/`send_message` 投递这三类指令性文本自「讨论页只展示 step
  // agent 消息与主代理消息」之后不再写入；旧实例快照里可能仍有历史记录，这里照原样返回。
  const userMessages = state.userMessages ?? [];
  return {
    instanceId,
    total: userMessages.length,
    userMessages: userMessages.slice(-limit),
    stepMessageCounts: state.executedSteps.map(step => ({
      stepId: step.stepId ?? step.id,
      status: step.status,
      count: hydratedMessagesOf(step)?.length ?? 0,
    })),
  };
}

/** 注册（`tools` 服务缺失时静默跳过）。 */
export function registerGlobalStatusTool(ctx: { get(name: string): unknown }, host: SandoreToolHost): () => void {
  const tools = ctx.get('tools') as { register(tool: unknown): () => void } | undefined;
  if (tools === undefined) {
    return () => {};
  }
  return tools.register({
    name: WORKFLOW_STATUS_TOOL_NAME,
    description: WORKFLOW_STATUS_TOOL_DESCRIPTION,
    parameters: WORKFLOW_STATUS_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: (args: unknown, exec: unknown) => losslessExecute(() => executeStatusTool(host, args, exec as SandoreToolExec)),
  });
}
