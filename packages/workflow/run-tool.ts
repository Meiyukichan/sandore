/**
 * sandore_workflow_run —— 工作流的**唯一启动入口**（架构决策 3）。
 *
 * 从调用会话（宿主主代理所在的那个真实顶层会话）拉起工作流实例：
 * - 若该会话已有一个 overlay 新建的 **pending 实例**（`sandore.startInstance` RPC 走
 *   的「建会话 → 注入上下文 → 等会话发起 run」路径），直接开跑（pending 请求为权威，
 *   本工具入参只做 `workflowId` 一致性校验）；
 * - 否则以调用会话为宿主新建实例（instanceId ≡ 调用会话 id）。
 *
 * 恒等式（架构决策 1）：`hostAgent.id ≡ 宿主会话 id ≡ instanceId ≡ 调用会话`。
 * 入参**没有** `hostSessionId` / `attachSession`：宿主会话永远是调用会话本身。
 * @module @meiyukichan/dsh-sandore/workflow/src/run-tool
 */
import { z } from 'zod';

import { SandoreError } from './errors.ts';
import type { DagStartRequest, StartModelSelection } from './types.ts';
import type { SandoreToolEnvelope, SandoreToolExec, SandoreToolHost } from './tool-support.ts';
import {
  PermissionSchema,
  TOOL_OUTPUT,
  assertCallerIsTopLevel,
  assertNoUnknownKeys,
  errorEnvelope,
  losslessExecute,
  requireCallerSessionId,
} from './tool-support.ts';

/** 工具注册名。 */
export const WORKFLOW_RUN_TOOL_NAME = 'sandore_workflow_run';

/** 工具 parameters。 */
export const WORKFLOW_RUN_PARAMETERS = {
  type: 'object',
  // 声明与运行时同口径：未知键被 execute 里的 assertNoUnknownKeys 拒绝（裸注册的工具
  // 不走 DSH 的入参 schema 校验，故这里必须显式拒绝，不能只靠声明）。
  additionalProperties: false,
  required: ['workflowId', 'originalInput'],
  properties: {
    workflowId: {
      type: 'string',
      description: '要启动的工作流定义 ID（wfl-…）。可以用 sandore_workflow 的 get-def/lib-list 查看可用定义。',
    },
    originalInput: {
      type: 'string',
      description: '用户原始需求（成为实例标题/需求与 Step 提示词的「用户指令」）。',
    },
    cwd: {
      type: 'string',
      description: '工作目录（必须为已存在目录；宿主主代理据此 attach web workspace）。缺省取调用会话 header.cwd。',
    },
    model: {
      type: 'object',
      additionalProperties: false,
      description: '本实例 L2 默认模型路由（不传则用引擎默认）。',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
      },
    },
    permission: {
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
      description: '实例权限预设（缺省继承宿主会话当前策略）。',
    },
  },
};

/** 工具描述（描述即契约）。 */
export const WORKFLOW_RUN_TOOL_DESCRIPTION = [
  'Start a sandore workflow instance from THIS session. This is the only way to start a workflow: the calling top-level session becomes the instance host session (host agent id === host session id === instance id).',
  '',
  'Required: workflowId + originalInput. cwd defaults to the calling session header cwd and must be an existing directory. Optional model/permission pin the instance route and sandbox policy. There is NO hostSessionId/attachSession parameter — the host session is always the caller.',
  '',
  'Returns {instanceId, status:"running"} — status is always "running" (the engine has already started the run; "pending" only exists internally on the overlay-create path). Execution is fire-and-forget: the engine drives every Step as its own subagent session; this tool returns immediately.',
  '',
  'Do NOT call this again for the same task before that instance ends (a session hosts one non-terminal instance). While it runs, collaborate through sandore_workflow_status / sandore_workflow_send_message / sandore_workflow_control; user questions and permission prompts from the run surface in this same session. When the instance ends, the engine wakes this session once — read the result with sandore_workflow_status and report it to the user.',
].join('\n');

/** 入参 zod（结构校验；跨字段规则见 {@link assertRunArgs}）。 */
export const WorkflowRunArgsSchema = z.object({
  workflowId: z.string(),
  originalInput: z.string(),
  cwd: z.string().optional(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  }).optional(),
  permission: PermissionSchema.optional(),
});

export type WorkflowRunArgs = z.infer<typeof WorkflowRunArgsSchema>;

/** 本工具的可用参数名（未知键报错时列出；由 zod shape 派生，避免与声明漂移）。 */
const RUN_TOOL_ALLOWED_KEYS = Object.keys(WorkflowRunArgsSchema.shape);

/** `model` 子对象的可用键（JSON schema 声明 `additionalProperties:false`，运行时同口径拒绝）。 */
const RUN_MODEL_ALLOWED_KEYS = Object.keys(WorkflowRunArgsSchema.shape.model.unwrap().shape);

/** 跨字段硬约束：workflowId / originalInput 非空（空串无意义且与实例标题/提示词语义相悖）。 */
function assertRunArgs(args: WorkflowRunArgs): void {
  if (args.workflowId === '') {
    throw new SandoreError('run 需要非空 workflowId', 'INVALID_OPERATION');
  }
  if (args.originalInput === '') {
    throw new SandoreError('run 需要非空 originalInput（用户原始需求）', 'INVALID_OPERATION');
  }
}

/** execute 入口：zod → 未知键 → gate → 跨字段规则 → 装配请求 → 引擎启动。 */
export async function executeRunTool(
  host: SandoreToolHost,
  raw: unknown,
  exec: SandoreToolExec,
): Promise<SandoreToolEnvelope> {
  const action = 'run';
  try {
    const args = WorkflowRunArgsSchema.parse(raw);
    // 未知键必须在业务动作之前拒绝（旧参数 hostSessionId/attachSession 之类静默吞掉
    // 会变成「成功但参数被忽略」；见 tool-support.assertNoUnknownKeys 的说明）。
    // 注意：**必须查原始入参 `raw`** —— zod 默认 strip，`args` 里的未知键早已被丢掉。
    assertNoUnknownKeys(raw, RUN_TOOL_ALLOWED_KEYS, WORKFLOW_RUN_TOOL_NAME);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const rawModel = (raw as Record<string, unknown>).model;
      if (rawModel !== undefined) {
        assertNoUnknownKeys(rawModel, RUN_MODEL_ALLOWED_KEYS, WORKFLOW_RUN_TOOL_NAME, 'model');
      }
    }
    assertCallerIsTopLevel(exec, WORKFLOW_RUN_TOOL_NAME);
    assertRunArgs(args);
    const hostSessionId = requireCallerSessionId(exec, WORKFLOW_RUN_TOOL_NAME);
    const cwd = args.cwd ?? exec.agent?.session?.header?.cwd;
    if (cwd === undefined || cwd === '') {
      throw new SandoreError('run 需要 cwd（显式传入，或从带 header.cwd 的顶层会话调用）', 'INVALID_OPERATION');
    }
    const model: StartModelSelection | undefined = args.model === undefined
      ? undefined
      : {
        provider: args.model.provider,
        model: args.model.model,
        ...(args.model.reasoningEffort === undefined ? {} : { reasoningEffort: args.model.reasoningEffort }),
      };
    const request: DagStartRequest = {
      workflowId: args.workflowId,
      originalInput: args.originalInput,
      cwd,
      ...(model === undefined ? {} : { model }),
      ...(args.permission === undefined ? {} : { permission: args.permission }),
    };
    return { ok: true, action, data: { ...(await host.runInstanceInSession(hostSessionId, request)) } };
  } catch (err) {
    // 本工具的 zod 面全是入参 → 参数问题一律 INVALID_OPERATION（见 tool-support.errorEnvelope）。
    return errorEnvelope(action, err, 'INVALID_OPERATION');
  }
}

/** 注册（`tools` 服务缺失时静默跳过）。 */
export function registerGlobalRunTool(ctx: { get(name: string): unknown }, host: SandoreToolHost): () => void {
  const tools = ctx.get('tools') as { register(tool: unknown): () => void } | undefined;
  if (tools === undefined) {
    return () => {};
  }
  return tools.register({
    name: WORKFLOW_RUN_TOOL_NAME,
    description: WORKFLOW_RUN_TOOL_DESCRIPTION,
    parameters: WORKFLOW_RUN_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: (args: unknown, exec: unknown) => losslessExecute(() => executeRunTool(host, args, exec as SandoreToolExec)),
  });
}
