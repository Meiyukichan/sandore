/**
 * sandore 工具面的共享设施（架构决策 3 的工具重设计公共层）。
 *
 * 五个 `sandore_workflow*` 模型工具（`sandore_workflow` / `_run` / `_status` /
 * `_send_message` / `_control`）共用本模块的信封、gate、错误映射与结构面，避免
 * 逐工具重复。注册方式对齐 `ask-tool.ts` 的全局注册前例：引擎 `[Service.init]` 期
 * `ctx.tools.register`（tools 服务缺失时静默跳过），execute 期 gate 仅放行**顶层
 * 主代理会话**（`header.parentSession === undefined`）——Step 子代理（委派会话）
 * 一律拒绝，防止子代理反向操纵工作流。
 * @module @meiyukichan/dsh-sandore/workflow/src/tool-support
 */
import { z } from 'zod';

import { SandoreError } from './errors.ts';
import type {
  MicroflowRecord,
  StepRecord,
  WorkflowDefinition,
  WorkflowDefinitionRecord,
  WorkflowTaskState,
} from './schema.ts';
import type { DagInstanceState, DagRun, DagStartRequest } from './types.ts';

/** 工具统一结果信封。 */
export interface SandoreToolEnvelope {
  ok: boolean;
  action?: string;
  data?: unknown;
  reason?: string;
  error?: { code: string; message: string };
  warnings?: string[];
}

/** 工具 execute 期上下文最小面（DSH 工具注册表注入；结构兼容 dsh Agent/Session）。 */
export interface SandoreToolExec {
  readonly agent?: {
    readonly session?: {
      readonly id?: string;
      readonly header?: {
        readonly cwd?: string;
        readonly parentSession?: string;
      };
    };
  };
  readonly signal?: AbortSignal;
}

/** 工具 output 渲染的字符上限（对齐 DSH 工具结果封顶习惯）。 */
export const RENDER_MAX_CHARS = 20000;

/** 从任意抛出值提取摘要（结构判定，不 import 运行时）。 */
export function summarizeError(err: unknown): { code: string; message: string } {
  if (!(err instanceof Error)) {
    return { code: 'UNKNOWN', message: String(err) };
  }
  const code = 'code' in err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
  return { code, message: err.message };
}

/**
 * 错误信封。zod 问题按阶段映射：入参结构问题（action 未定）→ `INVALID_OPERATION`；
 * 已定位到动作后的问题 → `zodCode`（缺省 `DEFINITION_INVALID`——`sandore_workflow` 的
 * 定义节点校验与 yaml 往返校验同码；单用途工具（run/status/send_message/control）的
 * zod 面全是**入参**，它们传 `'INVALID_OPERATION'`，避免把「参数写错」报成定义问题）。
 */
export function errorEnvelope(action: string | undefined, err: unknown, zodCode = 'DEFINITION_INVALID'): SandoreToolEnvelope {
  if (err instanceof z.ZodError) {
    const message = err.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return {
      ok: false,
      ...(action === undefined ? {} : { action }),
      reason: message,
      error: { code: action === undefined ? 'INVALID_OPERATION' : zodCode, message },
    };
  }
  const summary = summarizeError(err);
  return { ok: false, ...(action === undefined ? {} : { action }), reason: summary.message, error: summary };
}

/** 截断文本到上限（附截断标记）。 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

/**
 * execute 期 gate：仅顶层主代理会话可调用。
 *
 * 恒等式（架构决策 1）下宿主会话恒为顶层会话（无 `header.parentSession`）；Step 子代理
 * 的会话带 `parentSession`（= 宿主会话 id），故被本 gate 拒绝。
 * @param exec - 工具执行上下文。
 * @param toolName - 工具名（错误信息用）。
 */
export function assertCallerIsTopLevel(exec: SandoreToolExec, toolName: string): void {
  const agent = exec.agent;
  if (agent === undefined || agent.session === undefined) {
    throw new SandoreError(`${toolName} 仅可由顶层主代理会话调用（exec.agent 缺失）`, 'INVALID_OPERATION');
  }
  if (agent.session.header?.parentSession !== undefined) {
    throw new SandoreError(`${toolName} 仅可由顶层主代理会话调用（当前调用方是委派子代理）`, 'INVALID_OPERATION');
  }
}

/**
 * 拒绝**未知入参键**并把该工具的可用参数名回给模型（自纠用）。
 *
 * 为什么必须在 execute 入口显式做（而不是只靠 zod / JSON schema 声明）：
 * 本仓库的五个工具是**裸对象注册**（`ctx.tools.register({name, description, parameters, execute})`），
 * 而 DSH 的工具注册表只对 `defineTool` 造出来的工具做入参 schema 校验
 * （`deepseek-harness/packages/core/tools/src/index.ts` 的 dispatch 直接
 * `tool.execute(exec.arguments, exec)`；`defineTool` 才在 execute 里 `validateJsonSchemaValue`）。
 * 于是 `parameters` 里声明的任何约束都**只是给模型看的说明**，运行时唯一把关的是各工具
 * 自己的 zod；而 zod 的默认行为是**丢掉**未知键 → 「传了旧参数/形近错名参数」会
 * `ok:true` 但参数被静默忽略（审计实测：`run` 带 `hostSessionId`/`attachSession` 照常启动）。
 *
 * 本函数在 zod 校验之后、业务逻辑之前调用：非对象入参交给 zod 报结构错误，未知键一律
 * `INVALID_OPERATION` 且**列出可用参数**。
 *
 * @param raw - 模型给的原始入参。
 * @param allowed - 该工具的可用参数名（由 zod schema 的 shape 派生，避免与声明漂移）。
 * @param toolName - 工具名（错误信息用）。
 * @param path - 嵌套对象出错时的定位前缀（如 `model`）；根对象省略。
 */
export function assertNoUnknownKeys(raw: unknown, allowed: readonly string[], toolName: string, path?: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const unknown = Object.keys(raw as Record<string, unknown>).filter(key => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new SandoreError(
    `${toolName}${path === undefined ? '' : `.${path}`}: 未知参数 ${unknown.map(key => `'${key}'`).join('、')}`
    + `（可用参数：${allowed.join('、')}）。未知参数不会被忽略，请改用上面的参数名重试。`,
    'INVALID_OPERATION',
  );
}

/** 取调用方会话 id（缺省抛可读错误——无法确定宿主会话就无法定位实例）。 */
export function requireCallerSessionId(exec: SandoreToolExec, toolName: string): string {
  const sessionId = exec.agent?.session?.id;
  if (sessionId === undefined || sessionId === '') {
    throw new SandoreError(`${toolName} 需要调用会话 id（exec.agent.session.id 缺失）`, 'INVALID_OPERATION');
  }
  return sessionId;
}

/** 工具 output 通用渲染（JSON 文本 + 封顶截断）。 */
export function renderJsonValue(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = JSON.stringify(value, null, 2) ?? '';
  const truncated = truncateText(text, RENDER_MAX_CHARS);
  return [{ type: 'text', text: truncated.text + (truncated.truncated ? '\n… [truncated]' : '') }];
}

// ── 返回值边界：lossless JSON 规整 ─────────────────────────────────────────────

/**
 * 把任意值规整成 DSH 认可的 **lossless JSON**（工具返回值的硬约束）。
 *
 * 为什么必须有这一层：DSH 工具注册表在 execute 之后 `snapshotJsonValue(返回值)`，
 * 取不到快照就整次调用失败——模型看到的是
 * `tool "sandore_workflow_status" returned invalid output: value is not lossless JSON`，
 * 而不是「某个字段缺失」。真机实测（用户实例 `052d432f…`，10 个执行段）：
 * `parallel1` 是 shell 步骤，`sessionMeta` 里**没有** `childId`，而 `steps` 投影写的是
 * `{ childSessionId: step.sessionMeta.childId }` → 产出值为 `undefined` 的键 → 整个
 * `detail='steps'` 不可用（模型连试两次后只能绕道 `messages`/`step`）。
 *
 * DSH 的判据（`packages/util/values`：`snapshotJsonValue`）只接受 `null`/布尔/有限且
 * 非 -0 的数字/字符串/稠密本域数组/普通（或 null 原型）对象的可枚举字符串键；环引用、
 * 稀疏数组、symbol 与非枚举自有属性、函数、类实例一律拒绝。本函数把不合规的值**降级**
 * 成合规形态（丢掉 undefined 键、Date→ISO、Error→message、非有限数→null、环→丢弃该分支），
 * 让「某个字段没有值」永远不会升级成「整次工具调用失败」。
 *
 * 注意：这是**兜底**，不是借口。投影层仍应显式判断字段是否存在（见 status-tool 的
 * `stepSummaryRow`），本层只保证漏网的边缘值不会毁掉整次调用。
 *
 * @param value - 待规整的值（可为任意运行时值）。
 * @param seen - 递归中的祖先对象（环引用检测；调用方省略）。
 * @returns lossless JSON 值；`undefined` 表示该值应当被其父级**丢弃**。
 */
export function toLosslessJsonValue(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
    default:
      return undefined;
  }
  const object = value as object;
  if (seen.has(object)) return undefined;
  seen.add(object);
  try {
    if (object instanceof Date) return object.toISOString();
    if (object instanceof Error) return object.message;
    if (Array.isArray(object)) {
      // 稀疏数组/undefined 元素同样非法：按下标逐项规整（**不能用 map**——map 会跳过
      // 空位，结果仍是稀疏数组），落空的下标补 null 保持下标语义。
      const dense: unknown[] = [];
      for (let index = 0; index < object.length; index += 1) {
        dense.push(toLosslessJsonValue(object[index], seen) ?? null);
      }
      return dense;
    }
    const source = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const converted = toLosslessJsonValue(source[key], seen);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  } catch {
    // 取值即抛的宿主对象（getter 抛错、Proxy 陷阱等）：降级成可读字符串而不是让调用失败。
    return '[unserializable value]';
  } finally {
    seen.delete(object);
  }
}

/** 信封级 lossless 规整（工具 execute 的返回边界）。 */
export function losslessEnvelope(envelope: SandoreToolEnvelope): SandoreToolEnvelope {
  return toLosslessJsonValue(envelope) as SandoreToolEnvelope;
}

/**
 * 包一层 execute：内部实现照旧返回信封，边界统一做 lossless 规整。
 * @param run - 真正的工具实现。
 * @returns 规整后的信封。
 */
export async function losslessExecute(
  run: () => Promise<SandoreToolEnvelope>,
): Promise<SandoreToolEnvelope> {
  return losslessEnvelope(await run());
}

/** 工具结果信封的规范化 JSON Schema（`ok` 必填；data 收紧为 object）。 */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    // 注册表 assertSupportedJsonSchema 只支持基础类型子集（不支持 'json'），故收紧为 object。
    data: { type: 'object' },
    reason: { type: 'string' },
    error: { type: 'object' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** 工具 output 声明（schema + 通用 render）。 */
export const TOOL_OUTPUT = {
  schema: TOOL_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => renderJsonValue(value),
};

/** 权限预设枚举（run 工具的 permission 入参）。 */
export const PermissionSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

/** 实例状态枚举（status 工具的过滤入参）。 */
export const InstanceStatusSchema = z.enum([
  'pending',
  'running',
  'interacting',
  'completed',
  'failed',
  'aborted',
  'paused',
]);

// ── 工具用的实例级结构面（engine 结构满足；全部只调公开面） ─────────────────────

/** KvTable 最小面（`@deepseek-ai/dsh-storage-domain` KvTable 的用到的子集）。 */
export interface TableView<V> {
  get(key: string): V | undefined;
  entries(): Iterable<[string, V]>;
  put(key: string, value: V): Promise<void>;
}

/** sandorePersistence 的最小面（engine 侧 `ctx.get('sandorePersistence')` 包装）。 */
export interface SandoreManagerPersistenceSeam {
  readonly definitions: TableView<WorkflowDefinitionRecord>;
  readonly steps: TableView<StepRecord>;
  readonly microflows: TableView<MicroflowRecord>;
  readonly state: TableView<WorkflowTaskState>;
  writeDefinitionToLibraries(definition: WorkflowDefinition): Promise<void>;
}

/**
 * 工具宿主 seam（engine 公开方法 + persistence 访问器）。
 *
 * 五个工具共用：`sandore_workflow` 用 persistence + 定义装载；`_run` 用
 * `startInstance` / `runInstanceInSession`；`_status` 用
 * `findInstanceIdByHostSession` / `getState` / `getInstanceState` / persistence；
 * `_send_message` 用 `sendStepMessage`；`_control` 用
 * `pauseAllSteps` / `resumeAllSteps` / `retryStep` / `getInstanceState`。
 */
export interface SandoreToolHost {
  /** overlay 新建（建会话 + 注入上下文 + pending 实例）。 */
  startInstance(request: DagStartRequest): Promise<DagRun>;
  /** 唯一启动入口：在调用会话内拉起（pending 实例或新建绑定）。 */
  runInstanceInSession(hostSessionId: string, request: DagStartRequest): Promise<DagRun>;
  getState(instanceId: string): DagInstanceState;
  getInstanceState(instanceId: string): WorkflowTaskState | undefined;
  /**
   * 按需为 state 的执行段补上 `sessionMessages`（**不再持久化**的展示派生数据）。
   *
   * `sandore_workflow_status` 的 `step`/`messages` detail 与 `getInstanceState` RPC 共用：
   * 从各段子代理会话（`sessionMeta.childId`）现算展示行。
   * @param state - 待装饰的 state。
   * @returns 带 `sessionMessages` 的 state。
   */
  hydrateStateMessages(state: WorkflowTaskState): Promise<WorkflowTaskState>;
  /** 调用会话 → 该会话绑定的实例 id（恒等式下即会话 id；未绑定返回 undefined）。 */
  findInstanceIdByHostSession(hostSessionId: string): string | undefined;
  /** 暂停单个 Step。 */
  pauseStep(instanceId: string, stepId: string): Promise<void>;
  /** 暂停实例内全部 running/interacting Step。 */
  pauseAllSteps(instanceId: string): Promise<void>;
  /** 恢复单个 Step（可选恢复提示词）。 */
  resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
  /** 恢复实例内全部已暂停 Step。 */
  resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
  /** 重试失败 Step（continue=paused/failed 自动；本工具只用 fork 语义重建子代理）。 */
  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>;
  /** 向运行中 Step 子代理追加一条消息。 */
  sendStepMessage(instanceId: string, stepId: string, message: string): Promise<void>;
  persistence(): SandoreManagerPersistenceSeam | undefined;
}

// ── 段模型（executedSteps 多段）的共用口径 ──────────────────────────────────────

/** 单个执行段（`WorkflowTaskState.executedSteps` 元素）。 */
export type WorkflowExecutedStep = WorkflowTaskState['executedSteps'][number];

/** 段行的新旧键（`createdAt#attemptIndex`；与 status-tool 的段比较同口径）。 */
function segmentKeyOf(step: WorkflowExecutedStep): string {
  return `${step.createdAt ?? ''}#${step.attemptIndex ?? 0}`;
}

/** 段行的对外 step id（定义 stepId，缺省回退唯一执行 id）。 */
export function executedStepIdOf(step: WorkflowExecutedStep): string {
  return step.stepId ?? step.id;
}

/**
 * 每个 stepId 的**最新执行段**（段模型下的唯一权威口径）。
 *
 * 为什么必须共用：同一步骤在「暂停→续跑 / 失败→重建 / ask 续问」下会留下**多段**
 * （`attemptIndex` 递增），旧段的状态会永久停留在当时的值上。于是「按任意一段匹配」
 * 与「按最新段判定」会得出互相矛盾的结论（审计实测：一个 stepId 有 0/1 paused + 2 running
 * 时，`control continue` 先把它选为目标、再报「running 既非 paused 也非 failed」）。
 * 工具面的目标展开、状态判定、可投递性判定统一用本函数取值。
 *
 * 键序为 `createdAt#attemptIndex`（字符串比较，与 `status-tool` 同规则）；相等时取数组
 * 靠后者（`>=`），与「后写入的是最新」一致。
 *
 * @param steps - `state.executedSteps`。
 * @returns stepId → 最新段（插入序 = 该 stepId 首次出现序）。
 */
export function latestSegmentsByStep(steps: readonly WorkflowExecutedStep[]): Map<string, WorkflowExecutedStep> {
  const latest = new Map<string, WorkflowExecutedStep>();
  for (const step of steps) {
    const id = executedStepIdOf(step);
    const current = latest.get(id);
    if (current === undefined || segmentKeyOf(step) >= segmentKeyOf(current)) {
      latest.set(id, step);
    }
  }
  return latest;
}
