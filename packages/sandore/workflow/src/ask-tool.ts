/**
 * 子代理 child-scope `ask_user_question` 工具（双通道 ask **通道 1**）。
 *
 * 经 `ctx.subagents.registerContinuableSetup` 注入每个 sandore Step 子代理的
 * unpublished scope：`childCtx.tools.register` 注册同名工具（child-scope 注册天然
 * **遮蔽**全局版 DSH `ask_user_question`——工具注册表 `view()` 中 own layer 条目
 * 覆盖 inherited 同名条目，故无需 toolFilter deny）。
 *
 * 为何不能直调全局 ask_user_question（旧选 C 方案的根因）：sandore 子代理经
 * `startContinuable`（parent=宿主主代理）创建，`userQuestions.ask` 的
 * DELEGATED_CALLER 守卫会拒绝 owned-by-another-live-agent 的调用方；即便绕过，
 * question 帧也会路由到子代理会话（childId），主会话看不到选择框 → 无人回答 →
 * 子代理 turn 挂起 → 工作流卡死。本工具的 `execute` 不调 `ctx.userQuestions.ask`，
 * 而是经引擎 `askFromSubagent`（workflow-engine.ts）路由到**主会话**引擎级 ask
 * （hostAgent 身份、pendingInteractions 可见可答），答案以 DSH
 * `{ answers: [{ id, selected, custom? }] }` 形状返回子代理，子代理 turn 自然续跑
 * （不需要 followup 注回/重新 settle）。
 *
 * **计划写法说明（4.1）**：完整计划写的是「import defineTool + execute 里
 * `exec.ctx.get('sandoreEngine')` 拿引擎」。经 DSH 源码核验，真实 `ToolExecution`
 * 只有 `agent?`/`signal` 等字段、**没有 `ctx`**（core/tools/src/index.ts
 * ToolExecutionInput），故 `exec.ctx.get` 在真实 DSH API 上不可行。本实现改为
 * ①不 import `@deepseek-ai/dsh-tools`（结构兼容 DSH `ToolDefinition` 的普通对象，
 * 遵循 sandore 接缝哲学）；②引擎宿主经闭包注入（安装时捕获，execute 时调用），
 * 功能等价且可单测。**入参签名对齐计划**：`askFromSubagent(subagent, questions, signal)`
 * ——引擎从 `subagent.session.header.parentSession` 反查 ActiveInstance，工具无需
 * 感知 parentSession。
 *
 * 安装 gate（见 workflow-engine `registerSandoreAskToolSetup`）：仅当 child 的
 * `session.header.parentSession` 命中**当前非终态 sandore 实例**的宿主主代理会话
 * （反查 instances 表）时注入；其余 continuable child 不安装。
 * @module @deepseek-ai/dsh-sandore-workflow/src/ask-tool
 */
import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts';

/** 引擎侧 `askFromSubagent` 宿主最小面（由 SandoreEngineRuntime 结构满足）。 */
export interface SandoreAskToolHost {
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

/** 工具描述（引导子代理在需要确认/选择/缺失信息时提问）。 */
const ASK_TOOL_DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
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
 * 把 child-scope 工具注册进一个 continuable child 的 unpublished scope。
 *
 * @param childCtx - child-scoped context（DSH 真实环境为 Cordis Context，结构满足
 *   `{ tools: { register } }`）。
 * @param host - 引擎宿主（`askFromSubagent` 路由）。
 * @returns 该安装的 disposer（随 child scope 释放自动撤销）。
 */
export function installSandoreAskTool(
  childCtx: { readonly tools: { register(tool: unknown): () => void } },
  host: SandoreAskToolHost,
): () => void {
  return childCtx.tools.register({
    name: 'ask_user_question',
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
      if (agent === undefined) {
        throw new Error('ask_user_question requires a live calling agent');
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
  });
}
