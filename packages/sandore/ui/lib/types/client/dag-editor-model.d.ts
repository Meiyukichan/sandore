/**
 * DagEditor 的编辑态模型纯函数（无 React 依赖，可单测）。
 *
 * 定义经 `@deepseek-ai/dsh-sandore-workflow/yaml`（浏览器安全子路径）解析/序列化，
 * 编辑态模型即 `WorkflowDefinition`。此处提供新建骨架与五类型 command 工厂，
 * 供组件初始化与 Step 字段编辑复用，避免在 JSX 中散落结构常量。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dag-editor-model
 */
import type { CommandConfig, DagBranch, InputFromItem, OutputToItem, PassThroughVar, WorkflowDefinition, WorkflowStage, WorkflowStep } from '@deepseek-ai/dsh-sandore-workflow/schema';
/**
 * 合并视图 Step（V2 分离式）：Stage 流控位（`{id, branches?}`）与顶层定义
 * （`definition.steps[id]` 全字段）按 id 合并，供画布/编辑器读取完整字段。
 */
export type MergedStep = WorkflowStep & {
    branches?: DagBranch[];
};
/**
 * 构造某 Stage 的合并 Step 视图：`definition.steps[id]` 定义字段 + `stage.steps[id].branches`
 * 流控字段。顶层缺定义（旧数据/未同步）时退回 `{id}` 骨架。
 * @param definition - 工作流定义（含顶层 steps[]）。
 * @param stage - 目标 Stage（含流控位 steps[]）。
 * @returns 合并 Step 列表（顺序 = Stage 流控位顺序）。
 */
export declare function mergedStepsOf(definition: WorkflowDefinition, stage: WorkflowStage): MergedStep[];
/** 五类型命令判别字段（对齐 `CommandConfig` discriminated union）。 */
export type CommandType = CommandConfig['type'];
/** 全部五类型命令判别字段（编辑表单下拉项）。 */
export declare const COMMAND_TYPES: readonly CommandType[];
/** 生成带前缀的唯一 id（`{prefix}-{uuid}`），供 Stage/Step/ipt/opt 节点复用。 */
export declare function newId(prefix: string): string;
/** 构造一个新的空 Stage 节点（唯一 `stg-{uuid}` id + 空 steps）。 */
export declare function createStage(name: string): WorkflowStage;
/** 构造一个新的输入绑定项（唯一 `ipt-{uuid}` id）。 */
export declare function createInputFromItem(): InputFromItem;
/** 构造一个新的输出绑定项（唯一 `opt-{uuid}` id）。 */
export declare function createOutputToItem(): OutputToItem;
/** 构造一个空的透传变量项（`name`/`value`/`description` 待填）。 */
export declare function createPassThroughVar(): PassThroughVar;
/** 构造一个空的分支项（`next` 待填）。 */
export declare function createBranch(): DagBranch;
/** 去掉首尾空白，空串归 `undefined`（用于可选字段清除）。 */
export declare function trimToUndefined(value: string): string | undefined;
/** 解析可选的数字输入：空串/非法值归 `undefined`。 */
export declare function parseOptionalNumber(value: string): number | undefined;
/** 可编辑的命令文本字段（按类型收窄到 value 内的字段）。 */
export type CommandTextField = 'command' | 'promptText' | 'agentParamsTemplate' | 'providerId' | 'modelId';
/** 更新某类型命令的单个文本字段，返回新命令（可选字段空串 → 清除）。 */
export declare function updateCommandText(command: CommandConfig, field: CommandTextField, value: string): CommandConfig;
/**
 * 将保存后的真实 id 回填进定义模型（新建哨兵 `wfl-new` → `wfl-{uuid}`），
 * 使 YAML 预览基线反映已保存内容。
 * @param definition - 当前编辑态定义模型。
 * @param id - 保存回调返回的持久化 id。
 * @returns id 已更新的定义模型（其余字段不变）。
 */
export declare function withDefinitionId(definition: WorkflowDefinition, id: string): WorkflowDefinition;
/**
 * 构造某类型的最小合法命令（值为空串，待用户填写）。
 * @param type - 命令类型。
 * @returns 该类型的空命令配置。
 */
export declare function createCommand(type: CommandType): CommandConfig;
/** 新建定义的默认 id（首次保存由 Host `createDefinition` 生成 `wfl-{uuid}` 记录键）。 */
export declare const NEW_DEFINITION_ID = "wfl-new";
/**
 * 构造最小合法定义骨架（单个空 Stage），供「新建定义」进入空白 DagEditor。
 *
 * `skills`/`mcps`/`agents`/`settings` 显式给出默认值以对齐 `WorkflowDefinitionSchema`
 * 的 `.default()` 输出类型；`serializeWorkflowYaml` → `parseWorkflowYaml` 可深层相等往返。
 * @param id - 定义 id（新建默认 `wfl-new`）。
 * @returns 最小合法定义。
 */
export declare function createBlankDefinition(id?: string): WorkflowDefinition;
/** Stage 节点高度：随 Step 行数增长（封顶 6 行）。 */
export declare function stageNodeHeight(stepCount: number): number;
/** 单个 Step 的流出目标（branches[].next + branches[].loop.next，去空）。 */
export declare function stepTargetsOf(step: MergedStep): string[];
/** 流控边类型：串行 / 并行分支 / 条件分支 / 循环回边。 */
export type FlowEdgeKind = 'serial' | 'parallel' | 'conditional' | 'loop';
/** 流控边规格（供 DAG 画布渲染与 dagre 布局）。 */
export interface FlowEdgeSpec {
    readonly source: string;
    readonly target: string;
    readonly kind: FlowEdgeKind;
    /** 边标签（条件分支 label / 循环标识）。 */
    readonly label?: string | undefined;
}
/**
 * 分支是否为条件分支：有 `condition`（布尔判定命令）才算。无 `condition` = 并行分支
 * （始终纳入下一批）；有 `loop` 的分支是循环回边（其 `next` 指向更早节点）。
 */
export declare function isConditionalBranch(branch: DagBranch): boolean;
/**
 * 判断在 Stage 间新增连线 `source → target` 是否会形成回环（Stage DAG 不允许循环）。
 * 从 target 出发沿既有出边（branches[].next + branches[].loop.next）做可达性搜索：
 * 若可回到 source，则新增这条边会构成环。自环（source === target）也视为回环。
 * @param stages - 当前 Stage 列表（不含待加边）。
 * @param source - 连线起点。
 * @param target - 连线终点。
 * @returns 是否构成回环。
 */
export declare function wouldCreateStageCycle(stages: readonly WorkflowStage[], source: string, target: string): boolean;
/**
 * Stage 层流控边（branches 是唯一出边单元，**无循环**）：有 `condition` 的条件分支
 * 琥珀虚线（带 label），无 `condition` 的并行分支默认灰实线。未声明流控的孤立 Stage
 * 按定义顺序串行兜底（画布不画边，仅引擎推进）。
 * @param stages - 定义内的 Stage 列表。
 * @returns 去重后的流控边。
 */
export declare function stageFlowEdges(stages: readonly WorkflowStage[]): FlowEdgeSpec[];
/**
 * Step 层流控边（微流程：并行/条件 branches + **循环回边分支 loop**）。
 * 条件分支（有 condition）琥珀虚线带 label；循环分支（有 loop）`loop.next` 红色虚线
 * 回边；无 condition/loop 的并行分支默认灰实线。
 * @param steps - 某 Stage 内的合并 Step 列表（含 branches 流控）。
 * @returns 去重后的流控边。
 */
export declare function stepFlowEdges(steps: readonly MergedStep[]): FlowEdgeSpec[];
/** 参与 dagre 布局的节点尺寸。 */
export interface DagreNodeSpec {
    readonly id: string;
    readonly width: number;
    readonly height: number;
}
/** dagre 有向边。 */
export interface DagreEdgeSpec {
    readonly source: string;
    readonly target: string;
}
/**
 * 用 Dagre 计算分层布局（TB = 自上而下垂直流，官方 dagre 示例默认方向）。
 * 返回节点 id → 左上角坐标（React Flow 的 position 语义，dagre 输出的是中心点，
 * 需减半宽/高）。
 * @param nodes - 参与布局的节点。
 * @param edges - 有向边（自动去重）。
 * @returns 节点 id → 左上角坐标。
 */
export declare function dagreLayout(nodes: readonly DagreNodeSpec[], edges: readonly DagreEdgeSpec[]): Record<string, {
    x: number;
    y: number;
}>;
//# sourceMappingURL=dag-editor-model.d.ts.map