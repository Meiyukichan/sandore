/**
 * 全局注册的 `sandore_ask_user_question` 工具（双通道 ask **通道 1**，上游适配版）。
 *
 * **上游破坏性变更适配**：`ctx.subagents.registerContinuableSetup` 已删（上游 commit
 * 3091bdc257 设计否决 child-setup 贡献注册表），child-scope 注入通道不复存在。本工具
 * 改为**全局层注册 + execute 期 gate**（方案 a'）：引擎 `[Service.init]` 在引擎 ctx
 * `ctx.tools.register(...)` 注册本工具（全局工具对所有代理可见），`execute` 内校验
 * 调用方是「当前非终态 sandore 实例的 Step 子代理」——`exec.agent.session.header.
 * parentSession` 必须命中当前非终态实例的宿主主代理会话（引擎反查 instances 表），
 * 未命中抛带清晰说明的错误（非 sandore 子代理/宿主主代理误调用即拒绝，等价旧
 * contribution gate 的「不安装」，只是从注册期移到执行期）。
 *
 * sandore Step 子代理的 `startContinuable` request 携带
 * `toolFilter: { deny: ['ask_user_question'] }`（见 step-runner/finalize-manager），
 * 屏蔽 DSH 全局版 `ask_user_question`，引导模型使用本工具。
 *
 * 为何不能直调全局 ask_user_question（旧选 C 方案的根因，依旧成立）：sandore 子代理经
 * `startContinuable`（parent=宿主主代理）创建，`userQuestions.ask` 的
 * DELEGATED_CALLER 守卫会拒绝 owned-by-another-live-agent 的调用方；即便绕过，
 * question 帧也会路由到子代理会话（childId），主会话看不到选择框 → 无人回答 →
 * 子代理 turn 挂起 → 工作流卡死。本工具的 `execute` 不调 `ctx.userQuestions.ask`，
 * 而是经引擎 `askFromSubagent`（workflow-engine.ts）路由到**主会话**引擎级 ask
 * （hostAgent 身份、pendingInteractions 可见可答），答案以 DSH
 * `{ answers: [{ id, selected, custom? }] }` 形状返回子代理，子代理 turn 自然续跑
 * （queue 投递注回/重新 settle 由收尾闭环处理）。
 *
 * **实现注记**：①不 import `@deepseek-ai/dsh-tools`（结构兼容 DSH `ToolDefinition`
 * 的普通对象，遵循 sandore 接缝哲学）；②引擎宿主经闭包注入（注册时捕获，execute
 * 时调用），功能等价且可单测。**入参签名**：`askFromSubagent(subagent, questions,
 * signal)`——引擎从 `subagent.session.header.parentSession` 反查 ActiveInstance，工具
 * 无需感知 parentSession。
 * @module @meiyukichan/dsh-sandore/workflow/src/ask-tool
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '../microflow/subagents';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts';

/** 工具名（全局注册名；与 DSH 全局版 `ask_user_question` 区分，避免同名遮蔽歧义）。 */
export const SANDORE_ASK_TOOL_NAME = 'sandore_ask_user_question';

/** 引擎侧宿主最小面（由 SandoreEngineRuntime 结构满足）。 */
export interface SandoreAskToolHost {
  /**
   * ask 工具 gate 反查：给定调用方子代理的 `session.header.parentSession`，判断其
   * 是否命中**当前非终态 sandore 实例**的宿主主代理会话（反查 instances 表：
   * `instances[].hostAgent.id === parentSession` 且实例状态非终态）。
   *
   * @param parentSession - 调用方子代理的父会话 id（无父会话时为 undefined）。
   */
  isSandoreSubagentParentSession(parentSession: string | undefined): boolean;
  /**
   * 把子代理提问路由到主会话引擎级 ask 并等待用户回答。
   *
   * @param subagent - 调用方子代理（`session.header.parentSession` = 宿主主代理会话
   *   id，供引擎反查 ActiveInstance；`id` 供反查 Step 段）。
   * @param questions - 问题列表（DSH `AskUserQuestionItem` 驼峰形状）。
   * @param signal - 当前 turn 取消信号。
   */
  askFromSubagent(
    subagent: Agent,
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionAnswer>;
}

/** 工具参数（对齐 DSH `ask_user_question` 的 parameters 形状）。 */
export interface SandoreAskToolArgs {
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly question: string;
    readonly header?: string;
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    readonly multi_select?: boolean;
  }>;
}

/** 工具执行上下文最小面（`exec.agent` = 调用方子代理，`exec.signal` = 当前 turn 取消信号）。 */
export interface SandoreAskToolExec {
  readonly agent?: Agent;
  readonly signal?: AbortSignal;
}

/** 工具描述（说明这是 sandore 工作流子代理的提问通道，引导子代理在需要确认/选择/缺失信息时提问）。 */
const ASK_TOOL_DESCRIPTION =
  'Sandore workflow step subagent question channel. Ask the user a concise question when you need '
  + 'confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.';

/** 工具参数（蛇形 `multi_select`）→ `AskUserQuestionItem`（驼峰 `multiSelect`，对齐 DSH）。 */
function toAskItems(questions: readonly SandoreAskToolArgs['questions'][number][]): AskUserQuestionItem[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : { options: [...question.options] }),
    ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
  }));
}

/**
 * 构造全局 `sandore_ask_user_question` 工具定义（结构兼容 DSH `ToolDefinition`）。
 *
 * `execute` 内 gate：调用方 `exec.agent` 必须存在且其
 * `session.header.parentSession` 命中当前非终态 sandore 实例的宿主主代理会话
 * （`host.isSandoreSubagentParentSession` 反查），否则抛带清晰说明的错误。
 * @param host - 引擎宿主（gate 反查 + `askFromSubagent` 路由）。
 */
export function sandoreAskToolDefinition(host: SandoreAskToolHost): {
  name: string;
  description: string;
  parameters: unknown;
  output: unknown;
  execute(args: SandoreAskToolArgs, exec: SandoreAskToolExec): Promise<unknown>;
} {
  return {
    name: SANDORE_ASK_TOOL_NAME,
    description: ASK_TOOL_DESCRIPTION,
    parameters: {
      // 规范化 JSON Schema：required 只在 object 节点上用字符串数组（父节点 required 数组），
      // 不再使用子属性 `required: true` 简写（该形态非标准，传给 LLM 不可靠）。
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'question'],
            properties: {
              id: { type: 'string', description: '问题唯一标识' },
              question: { type: 'string', description: '问题文本' },
              header: { type: 'string', description: '可选标题' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: '是否多选' },
            },
          },
        },
      },
    },
    output: {
      // 规范化 enforced subset：required 仅允许出现在 type:'object' 节点上且为字符串数组
      // （DSH assertSupportedJsonSchema 校验，register 时对 output.schema 强制执行）。
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: SandoreAskToolArgs, exec: SandoreAskToolExec) {
      const agent = exec.agent;
      const parentSession = agent?.session?.header?.parentSession;
      if (agent === undefined || !host.isSandoreSubagentParentSession(parentSession)) {
        // gate 未命中（非 sandore 子代理 / 终态实例的后续子代理 / 宿主主代理自身）：
        // 拒绝执行（等价旧 contribution gate 的「不安装」，从注册期移到执行期）。
        throw new Error('sandore_ask_user_question is only available to sandore workflow step subagents');
      }
      const answer = await host.askFromSubagent(agent, toAskItems(args.questions), exec.signal);
      return {
        answers: answer.answers.map(item => ({
          id: item.id,
          selected: [...item.selected],
          ...(item.custom === undefined ? {} : { custom: item.custom }),
        })),
      };
    },
  };
}

/**
 * 在引擎 ctx（全局层）注册 `sandore_ask_user_question` 工具（上游适配：全局注册 +
 * execute 期 gate，替代已删除的 `registerContinuableSetup` child-scope 注入）。
 *
 * `tools` 服务缺失（最小桩部署/测试 ctx）时静默跳过（与旧 `registerSandoreAskToolSetup`
 * 对 `subagents` 缺失的降级一致）。
 * @param ctx - 引擎上下文（`ctx.get('tools')` 取全局工具注册表）。
 * @param host - 引擎宿主（闭包捕获；gate 反查 + askFromSubagent 路由）。
 * @returns 注册的 disposer（随插件生命周期撤销；tools 缺失时为空 disposer）。
 */
export function registerGlobalAskTool(ctx: Context, host: SandoreAskToolHost): () => void {
  const tools = (ctx as { get(name: string): unknown }).get('tools') as
    | { register(tool: unknown): () => void }
    | undefined;
  if (tools === undefined) {
    // 无全局工具注册表（最小桩部署）：跳过注册，不阻塞引擎启动。
    return () => {};
  }
  return tools.register(sandoreAskToolDefinition(host));
}
