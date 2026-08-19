/**
 * DagEditor 的编辑态模型纯函数（无 React 依赖，可单测）。
 *
 * 定义经 `@deepseek-ai/dsh-sandore-workflow/yaml`（浏览器安全子路径）解析/序列化，
 * 编辑态模型即 `WorkflowDefinition`。此处提供新建骨架与五类型 command 工厂，
 * 供组件初始化与 Step 字段编辑复用，避免在 JSX 中散落结构常量。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dag-editor-model
 */
import type {
  CommandConfig, DagBranch, InputFromItem, OutputToItem, PassThroughVar, WorkflowDefinition, WorkflowStage, WorkflowStep,
} from '@deepseek-ai/dsh-sandore-workflow/schema'

/**
 * 合并视图 Step（V2 分离式）：Stage 流控位（`{id, branches?}`）与顶层定义
 * （`definition.steps[id]` 全字段）按 id 合并，供画布/编辑器读取完整字段。
 */
export type MergedStep = WorkflowStep & { branches?: DagBranch[] }

/**
 * 构造某 Stage 的合并 Step 视图：`definition.steps[id]` 定义字段 + `stage.steps[id].branches`
 * 流控字段。顶层缺定义（旧数据/未同步）时退回 `{id}` 骨架。
 * @param definition - 工作流定义（含顶层 steps[]）。
 * @param stage - 目标 Stage（含流控位 steps[]）。
 * @returns 合并 Step 列表（顺序 = Stage 流控位顺序）。
 */
export function mergedStepsOf(definition: WorkflowDefinition, stage: WorkflowStage): MergedStep[] {
  const byId = new Map((definition.steps ?? []).map(step => [step.id, step] as const))
  return stage.steps.map(slot => ({
    ...(byId.get(slot.id) ?? { id: slot.id }),
    ...(slot.branches === undefined ? {} : { branches: slot.branches }),
  }))
}

/** 五类型命令判别字段（对齐 `CommandConfig` discriminated union）。 */
export type CommandType = CommandConfig['type']

/** 全部五类型命令判别字段（编辑表单下拉项）。 */
export const COMMAND_TYPES: readonly CommandType[] = ['shell', 'prompt', 'agent', 'skill', 'mcp']

/** 生成带前缀的唯一 id（`{prefix}-{uuid}`），供 Stage/Step/ipt/opt 节点复用。 */
export function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

/** 构造一个新的空 Stage 节点（唯一 `stg-{uuid}` id + 空 steps）。 */
export function createStage(name: string): WorkflowStage {
  return { id: newId('stg'), name, steps: [] }
}

/** 构造一个新的输入绑定项（唯一 `ipt-{uuid}` id）。 */
export function createInputFromItem(): InputFromItem {
  return { id: newId('ipt') }
}

/** 构造一个新的输出绑定项（唯一 `opt-{uuid}` id）。 */
export function createOutputToItem(): OutputToItem {
  return { id: newId('opt') }
}

/** 构造一个空的透传变量项（`name`/`value`/`description` 待填）。 */
export function createPassThroughVar(): PassThroughVar {
  return { name: '', value: '', description: '' }
}

/** 构造一个空的分支项（`next` 待填）。 */
export function createBranch(): DagBranch {
  return { next: '' }
}

/** 去掉首尾空白，空串归 `undefined`（用于可选字段清除）。 */
export function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 解析可选的数字输入：空串/非法值归 `undefined`。 */
export function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** 可编辑的命令文本字段（按类型收窄到 value 内的字段）。 */
export type CommandTextField = 'command' | 'promptText' | 'agentParamsTemplate' | 'providerId' | 'modelId'

/** 更新某类型命令的单个文本字段，返回新命令（可选字段空串 → 清除）。 */
export function updateCommandText(command: CommandConfig, field: CommandTextField, value: string): CommandConfig {
  const optional = trimToUndefined(value)
  switch (command.type) {
    case 'shell':
      return field === 'command' ? { type: 'shell', value: { command: value } } : command
    case 'prompt':
      if (field === 'promptText') return { type: 'prompt', value: { ...command.value, promptText: value } }
      if (field === 'providerId') return { type: 'prompt', value: { ...command.value, providerId: optional } }
      if (field === 'modelId') return { type: 'prompt', value: { ...command.value, modelId: optional } }
      return command
    case 'agent':
      if (field === 'promptText') return { type: 'agent', value: { ...command.value, promptText: value } }
      if (field === 'agentParamsTemplate') return { type: 'agent', value: { ...command.value, agentParamsTemplate: optional } }
      if (field === 'providerId') return { type: 'agent', value: { ...command.value, providerId: optional } }
      if (field === 'modelId') return { type: 'agent', value: { ...command.value, modelId: optional } }
      return command
    case 'skill':
      if (field === 'promptText') return { type: 'skill', value: { ...command.value, promptText: value } }
      if (field === 'providerId') return { type: 'skill', value: { ...command.value, providerId: optional } }
      return command
    case 'mcp':
      return field === 'promptText' ? { type: 'mcp', value: { promptText: value } } : command
  }
}

/**
 * 将保存后的真实 id 回填进定义模型（新建哨兵 `wfl-new` → `wfl-{uuid}`），
 * 使 YAML 预览基线反映已保存内容。
 * @param definition - 当前编辑态定义模型。
 * @param id - 保存回调返回的持久化 id。
 * @returns id 已更新的定义模型（其余字段不变）。
 */
export function withDefinitionId(definition: WorkflowDefinition, id: string): WorkflowDefinition {
  return { ...definition, id }
}

/**
 * 构造某类型的最小合法命令（值为空串，待用户填写）。
 * @param type - 命令类型。
 * @returns 该类型的空命令配置。
 */
export function createCommand(type: CommandType): CommandConfig {
  switch (type) {
    case 'shell':
      return { type: 'shell', value: { command: '' } }
    case 'prompt':
      return { type: 'prompt', value: { promptText: '' } }
    case 'agent':
      return { type: 'agent', value: { promptText: '' } }
    case 'skill':
      return { type: 'skill', value: { promptText: '' } }
    case 'mcp':
      return { type: 'mcp', value: { promptText: '' } }
  }
}

/** 新建定义的默认 id（首次保存由 Host `createDefinition` 生成 `wfl-{uuid}` 记录键）。 */
export const NEW_DEFINITION_ID = 'wfl-new'

/**
 * 构造最小合法定义骨架（单个空 Stage），供「新建定义」进入空白 DagEditor。
 *
 * `skills`/`mcps`/`agents`/`settings` 显式给出默认值以对齐 `WorkflowDefinitionSchema`
 * 的 `.default()` 输出类型；`serializeWorkflowYaml` → `parseWorkflowYaml` 可深层相等往返。
 * @param id - 定义 id（新建默认 `wfl-new`）。
 * @returns 最小合法定义。
 */
export function createBlankDefinition(id: string = NEW_DEFINITION_ID): WorkflowDefinition {
  return {
    id,
    name: '未命名工作流',
    version: '1.0.0',
    skills: [],
    mcps: [],
    agents: [],
    settings: { defaultTimeout: 120, maxConcurrentAgents: 4 },
    // 骨架 Stage 用 uuid（与 createStage 的 `stg-{uuid}` 一致，避免 stg-1 与后续添加
    // 的 uuid 格式混杂）。
    stages: [{ id: newId('stg'), name: '阶段 1', steps: [] }],
  }
}

// ── DAG 画布（React Flow + Dagre 布局） ─────────────────────────────────────

/** Stage 节点高度：随 Step 行数增长（封顶 6 行）。 */
export function stageNodeHeight(stepCount: number): number {
  return 48 + Math.min(stepCount, 6) * 20 + 12
}

/** 单个 Step 的流出目标（branches[].next + branches[].loop.next，去空）。 */
export function stepTargetsOf(step: MergedStep): string[] {
  const targets: string[] = []
  for (const branch of step.branches ?? []) {
    if (branch.next !== undefined && branch.next !== '') targets.push(branch.next)
    if (branch.loop?.next !== undefined && branch.loop.next !== '') targets.push(branch.loop.next)
  }
  return targets
}

/** 流控边类型：串行 / 并行分支 / 条件分支 / 循环回边。 */
export type FlowEdgeKind = 'serial' | 'parallel' | 'conditional' | 'loop'

/** 流控边规格（供 DAG 画布渲染与 dagre 布局）。 */
export interface FlowEdgeSpec {
  readonly source: string
  readonly target: string
  readonly kind: FlowEdgeKind
  /** 边标签（条件分支 label / 循环标识）。 */
  readonly label?: string | undefined
}

/**
 * 分支是否为条件分支：有 `condition`（布尔判定命令）才算。无 `condition` = 并行分支
 * （始终纳入下一批）；有 `loop` 的分支是循环回边（其 `next` 指向更早节点）。
 */
export function isConditionalBranch(branch: DagBranch): boolean {
  return branch.condition !== undefined
}

/**
 * 判断在 Stage 间新增连线 `source → target` 是否会形成回环（Stage DAG 不允许循环）。
 * 从 target 出发沿既有出边（branches[].next + branches[].loop.next）做可达性搜索：
 * 若可回到 source，则新增这条边会构成环。自环（source === target）也视为回环。
 * @param stages - 当前 Stage 列表（不含待加边）。
 * @param source - 连线起点。
 * @param target - 连线终点。
 * @returns 是否构成回环。
 */
export function wouldCreateStageCycle(stages: readonly WorkflowStage[], source: string, target: string): boolean {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const stage of stages) {
    const targets: string[] = []
    for (const branch of stage.branches ?? []) {
      if (branch.next !== undefined && branch.next !== '') targets.push(branch.next)
      if (branch.loop?.next !== undefined && branch.loop.next !== '') targets.push(branch.loop.next)
    }
    outgoing.set(stage.id, targets)
  }
  const visited = new Set<string>([target])
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (next === source) return true
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

/**
 * Stage 层流控边（branches 是唯一出边单元，**无循环**）：有 `condition` 的条件分支
 * 琥珀虚线（带 label），无 `condition` 的并行分支默认灰实线。未声明流控的孤立 Stage
 * 按定义顺序串行兜底（画布不画边，仅引擎推进）。
 * @param stages - 定义内的 Stage 列表。
 * @returns 去重后的流控边。
 */
export function stageFlowEdges(stages: readonly WorkflowStage[]): FlowEdgeSpec[] {
  const edges: FlowEdgeSpec[] = []
  const emitted = new Set<string>()
  const push = (edge: FlowEdgeSpec): void => {
    const key = `${edge.source}->${edge.target}:${edge.kind}`
    if (emitted.has(key)) return
    emitted.add(key)
    edges.push(edge)
  }
  for (const stage of stages) {
    for (const branch of stage.branches ?? []) {
      if (branch.next === undefined || branch.next === '') continue
      const conditional = isConditionalBranch(branch)
      push({
        source: stage.id,
        target: branch.next,
        kind: conditional ? 'conditional' : 'parallel',
        ...(branch.label !== undefined ? { label: branch.label } : {}),
      })
    }
  }
  return edges
}

/**
 * Step 层流控边（微流程：并行/条件 branches + **循环回边分支 loop**）。
 * 条件分支（有 condition）琥珀虚线带 label；循环分支（有 loop）`loop.next` 红色虚线
 * 回边；无 condition/loop 的并行分支默认灰实线。
 * @param steps - 某 Stage 内的合并 Step 列表（含 branches 流控）。
 * @returns 去重后的流控边。
 */
export function stepFlowEdges(steps: readonly MergedStep[]): FlowEdgeSpec[] {
  const byId = new Set(steps.map(step => step.id))
  const edges: FlowEdgeSpec[] = []
  const emitted = new Set<string>()
  const push = (edge: FlowEdgeSpec): void => {
    const key = `${edge.source}->${edge.target}:${edge.kind}`
    if (emitted.has(key)) return
    emitted.add(key)
    edges.push(edge)
  }
  for (const step of steps) {
    for (const branch of step.branches ?? []) {
      if (branch.next === undefined || branch.next === '' || !byId.has(branch.next)) continue
      const conditional = isConditionalBranch(branch)
      push({
        source: step.id,
        target: branch.next,
        kind: conditional ? 'conditional' : 'parallel',
        ...(branch.label !== undefined ? { label: branch.label } : {}),
      })
      if (branch.loop?.next !== undefined && branch.loop.next !== '') {
        if (byId.has(branch.loop.next)) {
          push({ source: step.id, target: branch.loop.next, kind: 'loop', ...(branch.loop.next === step.id ? { label: 'loop' } : {}) })
        }
      }
    }
  }
  return edges
}

// ── Dagre 自动布局（@dagrejs/dagre，React Flow 画布坐标） ───────────────────

import dagre from '@dagrejs/dagre'

/** 参与 dagre 布局的节点尺寸。 */
export interface DagreNodeSpec {
  readonly id: string
  readonly width: number
  readonly height: number
}

/** dagre 有向边。 */
export interface DagreEdgeSpec {
  readonly source: string
  readonly target: string
}

/**
 * 用 Dagre 计算分层布局（TB = 自上而下垂直流，官方 dagre 示例默认方向）。
 * 返回节点 id → 左上角坐标（React Flow 的 position 语义，dagre 输出的是中心点，
 * 需减半宽/高）。
 * @param nodes - 参与布局的节点。
 * @param edges - 有向边（自动去重）。
 * @returns 节点 id → 左上角坐标。
 */
export function dagreLayout(
  nodes: readonly DagreNodeSpec[],
  edges: readonly DagreEdgeSpec[],
): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  // TB 垂直流：同层节点横向间距 56、层间纵向间距 110，画布留白 24（参考官方示例）。
  graph.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 110, marginx: 24, marginy: 24 })
  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height })
  }
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`
    if (seen.has(key)) continue
    seen.add(key)
    graph.setEdge(edge.source, edge.target)
  }
  dagre.layout(graph)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) {
    const meta = graph.node(node.id)
    positions[node.id] = { x: meta.x - node.width / 2, y: meta.y - node.height / 2 }
  }
  return positions
}
