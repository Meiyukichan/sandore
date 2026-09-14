/**
 * sandore_workflow —— sandore 工作流**定义与库**管理工具（架构决策 3）。
 *
 * 工具重设计后本工具的职责收窄为**低频资源管理**：定义查改（`get-def`/`update-def`）
 * 与三类库浏览（`lib-list`/`lib-get`）。运行面已拆成独立工具（不再有 `run`/`get-state`
 * 两个 action，避免两套入口）：
 * - 启动：`sandore_workflow_run`（唯一入口，见 run-tool.ts）
 * - 状态：`sandore_workflow_status`（见 status-tool.ts）
 * - 发消息：`sandore_workflow_send_message`（见 message-tool.ts）
 * - 暂停/继续：`sandore_workflow_control`（见 control-tool.ts）
 *
 * 注册方式对齐 `ask-tool.ts` 的全局注册前例（经 host-tools.ts 统一注册）；execute 期
 * gate 仅顶层主代理会话（共享实现在 tool-support.ts）。
 *
 * 定义读写以 definitions 表 yaml 为唯一事实来源：读 = `parseWorkflowYaml`；写 =
 * 对象级 patch → `serializeWorkflowYaml` → `definitions.put`（元数据同步 + 往返校验，
 * 对齐 `remote.updateYaml` 的原子性）。库表只读（浏览），不参与运行。
 * @module @meiyukichan/dsh-sandore/workflow/src/manager-tool
 */
import { z } from 'zod';

import { SandoreError } from './errors.ts';
import { collectLibraryReferences, toLibrarySummary } from './library-views.ts';
import type {
  DagBranch,
  StageStep,
  WorkflowDefinition,
  WorkflowDefinitionRecord,
  WorkflowStage,
  WorkflowStep,
} from './schema.ts';
import { WorkflowStageSchema, WorkflowStepSchema } from './schema.ts';
import { parseWorkflowYaml, serializeWorkflowYaml } from './yaml-parser.ts';
import type {
  SandoreManagerPersistenceSeam,
  SandoreToolEnvelope,
  SandoreToolExec,
  SandoreToolHost,
} from './tool-support.ts';
import { TOOL_OUTPUT, assertCallerIsTopLevel, assertNoUnknownKeys, errorEnvelope, losslessExecute } from './tool-support.ts';

// 兼容re-export：引擎与既有调用点从本模块取 persistence seam 类型（现定义在 tool-support）。
export type { SandoreManagerPersistenceSeam, SandoreToolEnvelope, SandoreToolExec, SandoreToolHost };

// ── 常量与公开 schema ─────────────────────────────────────────────────────────

/** 工具注册名（sandore 前缀 + workflow 主题）。 */
export const WORKFLOW_MANAGER_TOOL_NAME = 'sandore_workflow';

/** sandore_workflow 支持的全部 action（架构决策 3：只剩定义/库读写）。 */
export type SandoreManagerAction = 'get-def' | 'update-def' | 'lib-list' | 'lib-get';

/** 工具 parameters（规范化 JSON Schema：required 只在 object 节点、字符串数组）。 */
export const WORKFLOW_MANAGER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['get-def', 'update-def', 'lib-list', 'lib-get'],
      description:
        '操作类型：get-def=查询工作流/Stage/Step 定义（不传 workflowId 时返回定义列表）；'
        + 'update-def=编辑定义节点；lib-list=浏览已有 工作流/Step 库(Agent)/微流程库(Microflow)；'
        + 'lib-get=读取单个库条目详情（供编排引用/借鉴）。'
        + '（运行实例请用 sandore_workflow_run；查实例状态请用 sandore_workflow_status。）',
    },
    workflowId: {
      type: 'string',
      description:
        '工作流定义 ID（wfl-…）。涉及 Stage/Step 的定义查改必传（Stage/Step id 只在单个工作流内唯一）。',
    },
    stageId: {
      type: 'string',
      description: 'Stage id（工作流内唯一）。get-def 定点用；update-def 定位 Step 时必传。',
    },
    stepId: {
      type: 'string',
      description:
        'Step id（工作流内顶层定义按 id 交叉引用）。get-def 定点 Step 用（多 stage slot 命中时返回全部）；update-def 定位 Step 时须与 stageId 同传。',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'update-def 的新值（浅合并到定位节点；节点 id 不可变更；数组字段整体替换）。',
    },
    lib: {
      type: 'string',
      enum: ['workflow', 'step', 'microflow'],
      description:
        'lib-list/lib-get 的库类型：workflow=工作流定义、step=Step 库（UI「Agent 库」）、microflow=微流程库（UI「Microflow 库」）。lib-list 缺省三类全列。',
    },
    entryId: {
      type: 'string',
      description: 'lib-get 的库条目 id（steps/microflows 表记录键；与工作流 yaml 内 stage/step 节点引用的是同一个字符串 id）。',
    },
  },
};

/** 工具描述（描述即契约）。 */
export const WORKFLOW_MANAGER_TOOL_DESCRIPTION = [
  'Sandore workflow definitions and libraries. One tool, four actions discriminated by `action`: query/edit workflow definitions and browse the definition/step/microflow libraries. This tool does NOT run workflows (use sandore_workflow_run) and does NOT read instance state (use sandore_workflow_status).',
  '',
  'Addressing rules (hard constraints):',
  '- Stage/Step ids are unique only inside a single workflow yaml (the same library entry id can be inlined into many workflows), so any stage/step-level operation MUST pass `workflowId`.',
  '- `update-def` at step level additionally REQUIRES `stageId` (the full step definition lives once in top-level `steps[]`; flow slots `{id, branches}` live inside stages). Reads may omit stageId: all matching slots are returned.',
  '',
  'Actions:',
  '- get-def: no args = definition list summaries; +workflowId = full merged definition (stages flow slots × top-level step definitions, engine/UI-identical merge) + `stepDefinitionCount` (and `orphanStepDefinitions` only for definitions that NO stage slot references — the merged view already carries every placed step, so the full definition list is not repeated); +stageId / +stepId = targeted stage/step merged view + in-library hints.',
  '- update-def: workflowId only = shallow-merge top-level metadata fields (name/version/description/engine/skills/mcps/agents/settings/rules/gates); +stageId = replace that WorkflowStage node (id immutable); +stageId+stepId = replace that step (definition fields -> top-level `steps[stepId]`, branches/inputFrom -> the stage slot). Write path: patch -> serialize -> parse-validate -> put (atomic, old value kept on failure). Warnings are returned when a referenced flow slot lacks a top-level definition (such a workflow saves but fails at runtime when the step executes).',
  '- lib-list: browse existing entries of the three libraries (default all): workflow definitions, Step library (UI: Agent 库), Microflow library (UI: Microflow 库); rows carry referencedBy counts (same criterion as delete protection).',
  '- lib-get: one library entry full record (step/microflow) + referencing workflows detail; use get-def for a workflow definition detail.',
  '',
  'Update semantics: last-write-wins (no optimistic locking) — always get-def first, then update-def against that snapshot. update-def (or deleting a definition elsewhere) never changes a running instance: each instance keeps the definition parsed at start, and terminal instances stay readable from their own state snapshots; crash-recovery of a non-terminal instance still requires the definition record.',
  '',
  'Libraries are independent snapshots: editing a library entry never changes saved workflows (and vice versa) — borrow fields via lib-get + update-def.',
].join('\n');

// ── 入参校验（zod + 运行时跨字段规则） ────────────────────────────────────────

/** 工具入参（先 zod 结构校验，再 {@link assertArgsRules} 跨字段规则）。 */
export const ManagerToolArgsSchema = z.object({
  action: z.enum(['get-def', 'update-def', 'lib-list', 'lib-get']),
  workflowId: z.string().optional(),
  stageId: z.string().optional(),
  stepId: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  lib: z.enum(['workflow', 'step', 'microflow']).optional(),
  entryId: z.string().optional(),
});

export type ManagerToolArgs = z.infer<typeof ManagerToolArgsSchema>;

/** 本工具的可用参数名（未知键报错时列出；由 zod shape 派生）。 */
const MANAGER_TOOL_ALLOWED_KEYS = Object.keys(ManagerToolArgsSchema.shape);

/**
 * 跨字段硬约束：① 定义寻址类 action 涉及 stage/step 时必传 workflowId；
 * ② update-def 定位 step 必传 stageId 且必传 workflowId；
 * ③ lib-get 必须 lib∈{step,microflow} 且带 entryId。
 */
function assertArgsRules(args: ManagerToolArgs): void {
  if ((args.stageId !== undefined || args.stepId !== undefined) && args.workflowId === undefined) {
    throw new SandoreError('stage/step 级定义操作必须携带 workflowId（stage/step id 只在单个工作流内唯一）', 'INVALID_OPERATION');
  }
  if (args.action === 'update-def' && args.stepId !== undefined && args.stageId === undefined) {
    throw new SandoreError('update-def 的 step 级定位必须携带 stageId（顶层定义单份、流控位按 stage 定位）', 'INVALID_OPERATION');
  }
  if (args.action === 'update-def' && args.workflowId === undefined) {
    throw new SandoreError('update-def 必须携带 workflowId', 'INVALID_OPERATION');
  }
  if (args.action === 'lib-get') {
    // S2：区分「忘了传 lib」与「lib 传了 workflow」——两者建议的动作不同。
    if (args.lib === undefined) {
      throw new SandoreError("lib-get 必须携带 lib（'step' 或 'microflow'）", 'INVALID_OPERATION');
    }
    if (args.lib === 'workflow') {
      throw new SandoreError("lib-get 不支持 lib='workflow'（workflow 定义详情请用 action='get-def' + workflowId）", 'INVALID_OPERATION');
    }
    if (args.entryId === undefined) throw new SandoreError('lib-get 必须携带 entryId', 'INVALID_OPERATION');
  }
}

/** execute 统一入口：zod 结构校验 → gate → 跨字段规则 → 分发；任何抛错转错误信封。 */
export async function executeManagerTool(
  host: SandoreToolHost,
  raw: unknown,
  exec: SandoreToolExec,
): Promise<SandoreToolEnvelope> {
  let action: SandoreManagerAction | undefined;
  try {
    const args = ManagerToolArgsSchema.parse(raw);
    action = args.action;
    assertNoUnknownKeys(raw, MANAGER_TOOL_ALLOWED_KEYS, WORKFLOW_MANAGER_TOOL_NAME);
    assertCallerIsTopLevel(exec, WORKFLOW_MANAGER_TOOL_NAME);
    assertArgsRules(args);
    switch (args.action) {
      case 'get-def':
        return { ok: true, action, data: await doGetDef(host, args) };
      case 'update-def':
        return await doUpdateDef(host, args);
      case 'lib-list':
        return { ok: true, action, data: await doListLibraries(host, args) };
      case 'lib-get':
        return { ok: true, action, data: await doGetLibraryEntry(host, args) };
    }
  } catch (err) {
    return errorEnvelope(action, err);
  }
}

// ── 分离式合并视图（对齐 client mergedStepsOf / engine merge） ────────────────

/** 合并视图 Step（流控位 branches × 顶层完整定义）。 */
export type MergedStepView = WorkflowStep & { branches?: DagBranch[] };

/** 分离式合并：slot 流控位 × 顶层完整定义（顶层缺失退回 `{ id }` 骨架，运行期同款退化）。 */
export function mergedStepView(definition: WorkflowDefinition, slot: StageStep): MergedStepView {
  const full = definition.steps?.find(step => step.id === slot.id);
  return { ...(full ?? { id: slot.id }), ...(slot.branches === undefined ? {} : { branches: slot.branches }) };
}

/** 定点 Stage 的合并视图；不存在抛 `NODE_NOT_FOUND`。 */
export function mergedStageView(definition: WorkflowDefinition, stageId: string): { stage: WorkflowStage; steps: MergedStepView[] } {
  const stage = definition.stages.find(candidate => candidate.id === stageId);
  if (stage === undefined) {
    throw new SandoreError(`stage '${stageId}' not found in workflow '${definition.id}'`, 'NODE_NOT_FOUND');
  }
  return { stage, steps: stage.steps.map(slot => mergedStepView(definition, slot)) };
}

/** stepId 在各 stage 流控位中的出现点（编辑定位/读取展示用）。 */
export function findStepSlots(definition: WorkflowDefinition, stepId: string): Array<{ stageId: string; slot: StageStep }> {
  const slots: Array<{ stageId: string; slot: StageStep }> = [];
  for (const stage of definition.stages) {
    for (const slot of stage.steps) {
      if (slot.id === stepId) slots.push({ stageId: stage.id, slot });
    }
  }
  return slots;
}

// ── persistence / 定义装载辅助 ────────────────────────────────────────────────

function requirePersistence(host: SandoreToolHost): SandoreManagerPersistenceSeam {
  const persistence = host.persistence();
  if (persistence === undefined) {
    throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
  }
  return persistence;
}

function requireDefinitionRecord(persistence: SandoreManagerPersistenceSeam, workflowId: string): WorkflowDefinitionRecord {
  const record = persistence.definitions.get(workflowId);
  if (record === undefined) {
    throw new SandoreError(`definition '${workflowId}' not found`, 'NODE_NOT_FOUND');
  }
  return record;
}

function loadDefinition(persistence: SandoreManagerPersistenceSeam, workflowId: string): { record: WorkflowDefinitionRecord; definition: WorkflowDefinition } {
  const record = requireDefinitionRecord(persistence, workflowId);
  return { record, definition: parseWorkflowYaml(record.yaml) };
}

/** 统计定义规模（stage 数 + 顶层 step 定义数；坏 yaml 由调用方 catch）。 */
function definitionCounts(definition: WorkflowDefinition): { stageCount: number; stepCount: number } {
  return { stageCount: definition.stages.length, stepCount: definition.steps?.length ?? 0 };
}

/** 库提示（inLibrary 展示用）：present = 库表存在同 id 条目（快照）；附条目 name/updatedAt。 */
function libraryHint(
  table: { get(key: string): { name: string; updatedAt: string } | undefined },
  id: string,
): { present: boolean; name?: string; libraryUpdatedAt?: string } {
  const record = table.get(id);
  if (record === undefined) return { present: false };
  return { present: true, name: record.name, libraryUpdatedAt: record.updatedAt };
}

// ── get-def ───────────────────────────────────────────────────────────────────

async function doGetDef(host: SandoreToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host);
  if (args.workflowId === undefined) {
    const rows: Array<Record<string, unknown>> = [];
    for (const [workflowId, record] of persistence.definitions.entries()) {
      try {
        const definition = parseWorkflowYaml(record.yaml);
        rows.push({
          workflowId,
          name: record.name,
          version: record.version,
          ...(record.description === undefined ? {} : { description: record.description }),
          ...definitionCounts(definition),
          updatedAt: record.updatedAt,
        });
      } catch {
        rows.push({ workflowId, name: record.name, version: record.version, parseError: true, updatedAt: record.updatedAt });
      }
    }
    return { definitions: rows };
  }

  const { record, definition } = loadDefinition(persistence, args.workflowId);
  if (args.stageId !== undefined) {
    const { stage, steps } = mergedStageView(definition, args.stageId);
    return {
      workflowId: args.workflowId,
      stage: { ...stage, steps },
      inLibrary: libraryHint(persistence.microflows, stage.id),
    };
  }
  if (args.stepId !== undefined) {
    const slots = findStepSlots(definition, args.stepId);
    if (slots.length === 0) {
      throw new SandoreError(`step '${args.stepId}' not found in workflow '${args.workflowId}'`, 'NODE_NOT_FOUND');
    }
    return {
      workflowId: args.workflowId,
      stepId: args.stepId,
      occurrences: slots.map(({ stageId, slot }) => ({ stageId, step: mergedStepView(definition, slot) })),
      inLibrary: libraryHint(persistence.steps, args.stepId),
    };
  }
  // S3 去重：完整 step 定义已经在上面 `stages[].steps[]` 的**合并视图**里各出现一次，
  // 故不再原样重复一份 `stepDefinitions`（旧实现把同一批定义返两遍，白烧 token）。
  // 只保留计数 + **未被任何 stage 流控位引用**的孤儿定义（这些在合并视图里看不到，
  // 去掉就会丢信息）。
  const placed = new Set(definition.stages.flatMap(stage => stage.steps.map(slot => slot.id)));
  const orphanStepDefinitions = (definition.steps ?? []).filter(step => !placed.has(step.id));
  return {
    workflowId: args.workflowId,
    name: record.name,
    version: record.version,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...definitionCounts(definition),
    updatedAt: record.updatedAt,
    stages: definition.stages.map(stage => ({
      id: stage.id,
      name: stage.name,
      ...(stage.branches === undefined ? {} : { branches: stage.branches }),
      steps: stage.steps.map(slot => mergedStepView(definition, slot)),
    })),
    stepDefinitionCount: (definition.steps ?? []).length,
    ...(orphanStepDefinitions.length === 0 ? {} : { orphanStepDefinitions }),
    libraryHints: {
      stages: definition.stages.map(stage => ({ id: stage.id, ...libraryHint(persistence.microflows, stage.id) })),
      steps: (definition.steps ?? []).map(step => ({ id: step.id, ...libraryHint(persistence.steps, step.id) })),
    },
  };
}

// ── update-def ────────────────────────────────────────────────────────────────

/** update-def 允许浅合并的 workflow 顶层元数据字段（结构性字段 stages/steps 除外）。 */
const WORKFLOW_META_KEYS = new Set(['name', 'version', 'description', 'engine', 'skills', 'mcps', 'agents', 'settings', 'rules', 'gates']);

/** 浅合并 fields 到目标对象（仅拷贝 fields 中显式提供的键；返回新对象）。 */
function shallowMerge(target: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(fields)) {
    merged[key] = value;
  }
  return merged;
}

/**
 * 落盘与元数据同步（对齐 remote.updateYaml：serialize → parse 往返校验 → put →
 * writeDefinitionToLibraries；校验失败抛错且记录保持旧值）。
 */
async function persistDefinitionUpdate(persistence: SandoreManagerPersistenceSeam, workflowId: string, definition: WorkflowDefinition): Promise<void> {
  const existing = requireDefinitionRecord(persistence, workflowId);
  const yaml = serializeWorkflowYaml(definition);
  const reparsed = parseWorkflowYaml(yaml); // 往返校验（YAML_PARSE/DEFINITION_INVALID 在写前抛出）
  const now = new Date().toISOString();
  await persistence.definitions.put(workflowId, {
    yaml,
    name: reparsed.name,
    version: reparsed.version,
    ...(reparsed.description === undefined ? {} : { description: reparsed.description }),
    createdAt: existing.createdAt,
    updatedAt: now,
  });
  await persistence.writeDefinitionToLibraries(reparsed);
}

/** 计算保存后警告：被引用的流控位缺顶层定义 / step 定义缺 command（能保存但运行到才报错）。 */
function definitionWarnings(definition: WorkflowDefinition): string[] {
  const warnings: string[] = [];
  const defined = new Set((definition.steps ?? []).map(step => step.id));
  const missing = new Set<string>();
  for (const stage of definition.stages) {
    for (const slot of stage.steps) {
      if (!defined.has(slot.id)) missing.add(slot.id);
    }
  }
  if (missing.size > 0) {
    warnings.push(`以下 Step 只在 Stage 流控位出现、缺少顶层完整定义（运行到时会失败）：${[...missing].sort().join(', ')}`);
  }
  const noCommand = (definition.steps ?? []).filter(step => step.command === undefined).map(step => step.id);
  if (noCommand.length > 0) {
    warnings.push(`以下 Step 定义没有 command（执行到时会失败）：${noCommand.sort().join(', ')}`);
  }
  return warnings;
}

async function doUpdateDef(host: SandoreToolHost, args: ManagerToolArgs): Promise<SandoreToolEnvelope> {
  const persistence = requirePersistence(host);
  const workflowId = args.workflowId!;
  const { definition } = loadDefinition(persistence, workflowId);
  const fields = args.fields ?? {};
  const warnings: string[] = [];

  if (args.stepId !== undefined) {
    const stageId = args.stageId!;
    const stage = definition.stages.find(candidate => candidate.id === stageId);
    if (stage === undefined) {
      throw new SandoreError(`stage '${stageId}' not found in workflow '${workflowId}'`, 'NODE_NOT_FOUND');
    }
    const slotIndex = stage.steps.findIndex(slot => slot.id === args.stepId);
    if (slotIndex < 0) {
      const candidates = findStepSlots(definition, args.stepId).map(slot => slot.stageId);
      throw new SandoreError(
        candidates.length === 0
          ? `step '${args.stepId}' not found in workflow '${workflowId}'`
          : `stage '${stageId}' has no slot for step '${args.stepId}'（该 step 出现在 stage：${candidates.join(', ')}）`,
        'NODE_NOT_FOUND',
      );
    }
    if (fields.id !== undefined && fields.id !== args.stepId) {
      throw new SandoreError('step id 不可变更（如需换 id 请删除旧 slot 后新增）', 'INVALID_OPERATION');
    }
    // 拆两段写回：纯定义字段 → 顶层 definition.steps[stepId]；branches/inputFrom → 流控位。
    const { branches, inputFrom, ...definitionFields } = fields as Record<string, unknown>;
    const existingDef = definition.steps?.find(step => step.id === args.stepId);
    const mergedDef = WorkflowStepSchema.parse(shallowMerge(existingDef ?? { id: args.stepId }, definitionFields));
    const steps = [...(definition.steps ?? []).filter(step => step.id !== args.stepId), mergedDef];
    const next: WorkflowDefinition = {
      ...definition,
      steps,
      stages: definition.stages.map(candidate =>
        candidate.id !== stageId
          ? candidate
          : {
            ...candidate,
            steps: candidate.steps.map((slot, index) =>
              index !== slotIndex
                ? slot
                : {
                  ...slot,
                  ...(branches === undefined ? {} : { branches: branches as StageStep['branches'] }),
                  ...(inputFrom === undefined ? {} : { inputFrom: inputFrom as StageStep['inputFrom'] }),
                },
            ),
          },
      ),
    };
    await persistDefinitionUpdate(persistence, workflowId, next);
    warnings.push(...definitionWarnings(next));
    return { ok: true, action: 'update-def', data: { workflowId, updated: 'step', stageId, stepId: args.stepId }, ...(warnings.length === 0 ? {} : { warnings }) };
  }

  if (args.stageId !== undefined) {
    const stageId = args.stageId;
    const stageIndex = definition.stages.findIndex(candidate => candidate.id === stageId);
    if (stageIndex < 0) {
      throw new SandoreError(`stage '${stageId}' not found in workflow '${workflowId}'`, 'NODE_NOT_FOUND');
    }
    if (fields.id !== undefined && fields.id !== stageId) {
      throw new SandoreError('stage id 不可变更（stage id 是流控引用键）', 'INVALID_OPERATION');
    }
    const mergedStage = WorkflowStageSchema.parse(shallowMerge(definition.stages[stageIndex] as unknown as Record<string, unknown>, fields));
    const next: WorkflowDefinition = {
      ...definition,
      stages: definition.stages.map((candidate, index) => (index === stageIndex ? mergedStage : candidate)),
    };
    await persistDefinitionUpdate(persistence, workflowId, next);
    warnings.push(...definitionWarnings(next));
    return { ok: true, action: 'update-def', data: { workflowId, updated: 'stage', stageId }, ...(warnings.length === 0 ? {} : { warnings }) };
  }

  // workflow 元数据浅合并（结构性字段忽略并提示）。
  const ignored = Object.keys(fields).filter(key => !WORKFLOW_META_KEYS.has(key));
  const next: WorkflowDefinition = { ...definition, ...(Object.fromEntries(Object.entries(fields).filter(([key]) => WORKFLOW_META_KEYS.has(key))) as Partial<WorkflowDefinition>) };
  await persistDefinitionUpdate(persistence, workflowId, next);
  if (ignored.length > 0) {
    warnings.push(`字段 ${ignored.join(', ')} 属于结构字段，未随元数据更新修改（stage/step 结构请带 stageId/stepId 定位修改）`);
  }
  return { ok: true, action: 'update-def', data: { workflowId, updated: 'workflow' }, ...(warnings.length === 0 ? {} : { warnings }) };
}

// ── lib-list / lib-get ────────────────────────────────────────────────────────

async function doListLibraries(host: SandoreToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host);
  const refs = collectLibraryReferences(persistence.definitions);
  const kinds: Array<'workflow' | 'step' | 'microflow'> =
    args.lib === undefined ? ['workflow', 'step', 'microflow'] : [args.lib];
  const result: Array<Record<string, unknown>> = [];
  for (const kind of kinds) {
    if (kind === 'workflow') {
      const entries: Array<Record<string, unknown>> = [];
      for (const [workflowId, record] of persistence.definitions.entries()) {
        try {
          const definition = parseWorkflowYaml(record.yaml);
          entries.push({
            id: workflowId,
            name: record.name,
            version: record.version,
            ...(record.description === undefined ? {} : { description: record.description }),
            ...definitionCounts(definition),
            updatedAt: record.updatedAt,
          });
        } catch {
          entries.push({ id: workflowId, name: record.name, version: record.version, parseError: true, updatedAt: record.updatedAt });
        }
      }
      result.push({ kind, entries });
      continue;
    }
    const table = kind === 'step' ? persistence.steps : persistence.microflows;
    const refsMap = kind === 'step' ? refs.stepRefs : refs.microflowRefs;
    const entries = [];
    for (const [id, record] of table.entries()) {
      entries.push(toLibrarySummary(id, record, refsMap));
    }
    result.push({ kind, entries });
  }
  return { libraries: result };
}

async function doGetLibraryEntry(host: SandoreToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host);
  const kind = args.lib as 'step' | 'microflow';
  const entryId = args.entryId!;
  const table = kind === 'step' ? persistence.steps : persistence.microflows;
  const record = table.get(entryId);
  if (record === undefined) {
    const uiName = kind === 'step' ? 'Agent 库' : 'Microflow 库';
    throw new SandoreError(`${kind} 库条目 '${entryId}' not found（${uiName}）`, 'NODE_NOT_FOUND');
  }
  const refs = collectLibraryReferences(persistence.definitions);
  const refsMap = kind === 'step' ? refs.stepRefs : refs.microflowRefs;
  const owners = [...(refsMap.get(entryId) ?? new Set<string>())].sort();
  return {
    kind,
    entry: record,
    referencedBy: owners.map(workflowId => ({
      workflowId,
      name: persistence.definitions.get(workflowId)?.name ?? '',
    })),
  };
}

// ── 注册（对齐 registerGlobalAskTool 的降级哲学） ─────────────────────────────

/**
 * 在引擎 ctx（全局层）注册 `sandore_workflow` 工具。
 *
 * `tools` 服务缺失（最小桩部署/测试 ctx）时静默跳过（返回空 disposer）。工具可见于
 * 全部会话；execute 期 gate 拒绝非顶层调用方。
 * @param ctx - 引擎上下文（`ctx.get('tools')` 取全局工具注册表）。
 * @param host - 工具宿主 seam。
 * @returns 注册的 disposer（随插件生命周期撤销；tools 缺失时为空 disposer）。
 */
export function registerGlobalManagerTool(ctx: { get(name: string): unknown }, host: SandoreToolHost): () => void {
  const tools = ctx.get('tools') as { register(tool: unknown): () => void } | undefined;
  if (tools === undefined) {
    // 无全局工具注册表（最小桩部署）：跳过注册，不阻塞引擎启动。
    return () => {};
  }
  return tools.register({
    name: WORKFLOW_MANAGER_TOOL_NAME,
    description: WORKFLOW_MANAGER_TOOL_DESCRIPTION,
    parameters: WORKFLOW_MANAGER_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: (args: unknown, exec: unknown) => losslessExecute(() => executeManagerTool(host, args, exec as SandoreToolExec)),
  });
}
