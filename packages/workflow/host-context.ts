/**
 * 宿主主代理的协作上下文注入文本与消息 source（架构决策 4 + 呈现形态修复）。
 *
 * overlay 新建流程（`startInstance`）建好真实顶层会话后，先注入本段文本再让该会话
 * 调用 `sandore_workflow_run` 拉起工作流：文本既下达「用户指令」，也把工作流的协作
 * 规则（查看/发消息/暂停/继续/提问审批落点/不要重复 run）一次讲清——宿主主代理在
 * 工作流运行期间保持自主（架构决策 2 删除了冻结机制），只靠这份规则与
 * `sandore_workflow_*` 工具协作。
 *
 * 文本部分为纯函数、无副作用；source 部分按 DSH 官方上下文注入契约构造
 * （见 {@link hostContextSource} 的逐条查证）。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-context
 */
import { boundContextSummary } from '@deepseek-ai/dsh-llm';

// ── 宿主会话消息的 source（DSH 上下文注入契约） ────────────────────────────────

/** 宿主会话上下文注入消息的 producer 名（左侧注入行上显示的名字）。 */
export const HOST_CONTEXT_PLUGIN = 'dsh-sandore';

/**
 * DSH 上下文注入消息的 source 形状（`kind !== 'user'` ⇒ 左侧「上下文注入」行）。
 *
 * **契约（逐条查证自 DSH 源码，非猜测）**：
 * - 客户端**按 `source.kind !== 'user'` 判定**渲染成左侧注入行——`ui-chat/src/client/
 *   conversation-nodes/message.ts:50-59`：非 `user` 的 `user/message` 产出
 *   `{ kind:'context', provenance, form }` 节点；`user` 才走右侧用户气泡。
 * - 行标题是 `message.contextInjection`（`ui-chat/src/client/locale.ts:46` =「上下文注入」），
 *   标签取 `source.plugin`（`conversation-nodes/event-projection.ts:69-70`），
 *   `notice` 形态的 `summary` 骑在折叠行上（`chat/ContextInjectionRow.tsx:44-57`）。
 * - `form:'notice'` **必须带非空 `summary`** 才渲染 notice 体，否则回落 opaque 体
 *   （`chat/ContextBody.tsx:551-591`）；`summary` 官方绑定 120 字符
 *   （`llm/src/message.ts:114-125 boundContextSummary`）。
 * - `source` 对会话日志无约束（`core/session/src/invariant.ts:145-146` 的
 *   `case 'user/message': break`），且**模型只读 `content`**——换成注入 source 不改变
 *   模型看到的文本。
 *
 * 官方先例：`webhook/src/session.ts:155-166`（`form:'notice'` + `summary`，经
 * `agent.followup` 投递）、`tool-jobs/src/index.ts:288`、`plan-mode/src/index.ts:459`
 * （均为 `{kind:'plugin', plugin:<name>, form:'notice', summary}`）。
 */
export interface HostContextSource {
  /** DSH 内建的 `plugin` 生产者类别（故无需 merge-extend `MessageSourceMap`）。 */
  readonly kind: 'plugin';
  /** producer 名（左侧注入行的标签）。 */
  readonly plugin: string;
  /** 呈现形态：`notice` = 折叠行一行 account + 展开看正文。 */
  readonly form: 'notice';
  /** 折叠行上的一行 account（≤120 字符）。 */
  readonly summary: string;
}

/**
 * 构造宿主会话上下文注入消息的 source。
 *
 * **source 不决定是否唤醒 agent**：唤醒由投递 API 决定——`Agent.followup` 排入
 * next-turn 并唤醒驱动（`core/agent-loop/src/agent.ts:131-133`），`Agent.inject` 同队列
 * 但不唤醒（`:139-141`）。本插件两处宿主消息都用 `followup`，故照旧触发宿主的 turn，
 * 只是**呈现**从右侧用户气泡变成左侧上下文注入行。
 * @param summary - 折叠行的一行 account（内部按官方上限截断）。
 * @returns 官方形态的 context 注入 source。
 */
export function hostContextSource(summary: string): HostContextSource {
  return {
    kind: 'plugin',
    plugin: HOST_CONTEXT_PLUGIN,
    form: 'notice',
    summary: boundContextSummary(summary),
  };
}

/** {@link buildHostContextInjection} 的入参。 */
export interface HostContextInjectionInput {
  /** 工作流定义 id（写入「启动参数」提示，供模型原样传给 `sandore_workflow_run`）。 */
  readonly workflowId: string
  /** 工作流名称（人类可读，用于「工作流「<name>」」）。 */
  readonly workflowName: string
  /** 用户原始需求。 */
  readonly originalInput: string
}

/**
 * 构建注入给宿主主代理的协作上下文。
 *
 * 要点（不可少）：① 明确让主代理调用 `sandore_workflow_run` 启动；② 不要自己动手
 * 完成该任务，但可继续处理周边任务；③ 协作手段四条（status / send_message /
 * control pause / control continue）+ 提问审批落点 + 不要重复 run。
 *
 * 「启动参数」一行是本仓库对任务书原文的最小补充：模型要填 `sandore_workflow_run`
 * 的必填入参 `workflowId`，而原文只给了工作流**名称**。
 * @param input - 工作流 id/名称与用户原始需求。
 * @returns 注入文本（Markdown）。
 */
export function buildHostContextInjection(input: HostContextInjectionInput): string {
  return [
    '## 用户指令',
    `用户选择用工作流「${input.workflowName}」执行下面这个任务，请调用 sandore_workflow_run 启动它：`,
    input.originalInput,
    '',
    `（启动参数：workflowId = "${input.workflowId}"，originalInput = 上面这段任务原文；cwd/model/permission 新建时已选好，无需重复传。）`,
    '',
    '## 工作流协作规则',
    '工作流启动后由引擎独立驱动它的各个 Step（每个 Step 是一个子代理会话）。',
    '不要自己动手完成该任务，但你可以继续处理其它周边任务，并按以下方式与工作流协作：',
    '',
    '- 查看进展与结果：`sandore_workflow_status`（detail: summary | steps | step | messages；看某步细节传 stepId）'
    + ' —— **按需读取**（用户询问、排障、或工作流已结束时），不要定期轮询。',
    "- 给正在执行的 Step 发消息：`sandore_workflow_send_message`（targets: ['all'] 广播 / ['<stepId>'] 定点 / 多元素批量）",
    '  —— 用户通常只会说**步骤名称**：请先用 `sandore_workflow_status`（detail: steps）查出对应的 stepId 再发，不要凭猜测填 id；',
    '  用户只说"给工作流发消息"（没指定步骤）时用 targets: [\'all\'] 广播。',
    "- 觉得执行开始走偏：`sandore_workflow_control`（action: 'pause'）",
    "- 暂停后继续、或某步失败后重试：`sandore_workflow_control`（action: 'continue'；引擎会自动选择继续现有子代理或重建）",
    '- 工作流运行期间的提问与审批会出现在本会话，请照常作答',
    '- 同一任务结束前不要重复调用 sandore_workflow_run；结束后用 sandore_workflow_status 读取结果并汇报给用户',
    '',
    '## 汇报口径（重要）',
    '只在以下情形向用户发言：① 工作流已结束（先用 sandore_workflow_status 读取结果再汇报）；'
    + '② 用户主动询问；③ 出现需要用户决策的问题（提问 / 审批卡片）。',
    '**不要在运行过程中逐 Step 主动汇报进展**：各 Step 的状态与输出由引擎驱动、并在运行视图里实时展示，'
    + '你不需要也不要定期轮询进度，或主动播报「当前阶段 / 某步正在执行 / 门禁结论」这类中间进展——'
    + '那会打断用户，且属于重复信息。',
  ].join('\n')
}
