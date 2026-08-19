/**
 * 交互管理器（引擎级 ask 主通道 + pending Map 镜像持久化 + 兼容回复路径 +
 * 子代理 ask 转接 + 权限镜像）。
 *
 * `InteractionManager` 是「纯协调器」：维护 `pendingQuestions`/`pendingPermissions`
 * Map（requestId → 条目）与终态条目历史，在登记/回复/拒绝时经注入的
 * `persist`/`emitQuestion`/`emitPermission` 回调把结构化条目同步到
 * `WorkflowTaskState.pendingInteractions` 并双发 `sandore/question`/
 * `sandore/permission` 事件。引擎级 ask 的权威路径是 `ctx.userQuestions.ask`
 * 的 await；`replyQuestion`/`replyPermission` 是兼容回复路径（resolve 内部等待
 * Promise，与 ask 的 await 汇合），供 DSH 卡片通道不可用（如 headless 测试）时使用。
 * @module @deepseek-ai/dsh-sandore-workflow/src/interaction-manager
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import { SandoreError } from './errors.ts';
import { AskUserQuestionPayloadSchema } from './schema.ts';
import type { UserQuestions } from './seam.ts';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionPayload,
  PendingPermissionEntry,
  PendingQuestionEntry,
} from './types.ts';

/** pending 交互条目（question/permission 联合）。 */
export type PendingInteractionEntry = PendingQuestionEntry | PendingPermissionEntry;

/** 权限回复取值（与 seam `replyPermission` 一致）。 */
export type PermissionReply = 'once' | 'always' | 'reject';

/** 交互管理器依赖（由引擎注入，保持纯协调器可单测）。 */
export interface InteractionManagerOptions {
  /** 宿主主代理（`ctx.userQuestions.ask` 的 agent 身份）。 */
  readonly hostAgent: Agent;
  /** `ctx.userQuestions` 软依赖获取器（可能不存在）。 */
  readonly userQuestions: () => UserQuestions | undefined;
  /** 把当前 pending 条目全量镜像持久化到状态快照。 */
  readonly persist: (entries: PendingInteractionEntry[]) => void;
  /** 双发 `sandore/question` 事件（Cordis + Session append）。 */
  readonly emitQuestion: (entry: PendingQuestionEntry) => void;
  /** 双发 `sandore/permission` 事件（Cordis + Session append）。 */
  readonly emitPermission: (entry: PendingPermissionEntry) => void;
  /** 子代理 ask 转接后的答案注回动作。 */
  readonly followup: (childId: string, content: ContentBlock[]) => Promise<void> | void;
}

/** 等待中的问答 Promise 解析器（`ask` 与 `replyQuestion` 汇合点）。 */
interface QuestionWaiter {
  readonly resolve: (answer: AskUserQuestionAnswer) => void;
  readonly reject: (reason: unknown) => void;
}

/** 子代理 ask 标记块起止定界。 */
const ASK_MARKER_START = '[[SANDORE_ASK]]';
const ASK_MARKER_END = '[[/SANDORE_ASK]]';

/** 生成请求关联 ID。 */
function makeRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** 提取 ContentBlock[] 中的纯文本（仅 text 块）。 */
function textOf(output: readonly ContentBlock[]): string {
  const texts: string[] = [];
  for (const block of output) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/** 蛇形 `AskUserQuestionPayload` → 驼峰 `AskUserQuestionItem[]`（对齐 DSH）。 */
function toAskItems(payload: AskUserQuestionPayload): AskUserQuestionItem[] {
  return payload.questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
  }));
}

/** `AskUserQuestionAnswer` → 持久化条目 answer 的 `string[][]` 形状。 */
function toAnswerArray(answer: AskUserQuestionAnswer): string[][] {
  return answer.answers.map(item => item.selected);
}

/**
 * `AskUserQuestionAnswer` → 注回子代理/写 userMessages 的可读文本。
 *
 * 每题一行：选中项 `selected` 用 `、` 连接，`custom` 自由文本追加为「（补充：…）」；
 * 无选中项仅自由文本时输出自由文本本身。空答案条目跳过。
 * @param answer - 用户整批回答。
 * @returns 多行可读文本。
 */
export function buildAnswerText(answer: AskUserQuestionAnswer): string {
  return answer.answers
    .map(item => {
      const parts: string[] = [];
      if (item.selected.length > 0) {
        parts.push(item.selected.join('、'));
      }
      const custom = item.custom?.trim();
      if (custom !== undefined && custom !== '') {
        parts.push(`补充：${custom}`);
      }
      return parts.length > 1 ? `${parts[0]}（${parts.slice(1).join('；')}）` : (parts[0] ?? '');
    })
    .filter(part => part !== '')
    .join('\n');
}

/**
 * 解析子代理 final result 中的保守标记块 `[[SANDORE_ASK]]{...json...}[[/SANDORE_ASK]]`。
 *
 * 仅解析首个标记块；JSON 解析失败、`AskUserQuestionPayloadSchema` 校验不通过或
 * `questions` 为空均返回 `undefined`（按普通输出处理，不转接）。
 * @param text - 子代理 final result 的纯文本。
 * @returns 合法 ask 载荷，或无合法标记块时为 `undefined`。
 */
export function parseDelegatedAsk(text: string): AskUserQuestionPayload | undefined {
  const start = text.indexOf(ASK_MARKER_START);
  if (start < 0) {
    return undefined;
  }
  const jsonStart = start + ASK_MARKER_START.length;
  const end = text.indexOf(ASK_MARKER_END, jsonStart);
  if (end < 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, end));
  } catch {
    return undefined;
  }
  const result = AskUserQuestionPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  if (result.data.questions.length === 0) {
    return undefined;
  }
  return result.data;
}

/**
 * 交互管理器。
 *
 * Map 仅维护「活跃 pending」条目（用于 reply 路由）；终态（replied/rejected）
 * 条目进入 `resolvedEntries` 历史并随每次 `syncState` 一并镜像到快照，保证
 * `pendingInteractions` 始终是「pending + 终态」的全量历史。
 */
export class InteractionManager {
  private readonly pendingQuestions = new Map<string, PendingQuestionEntry>();
  private readonly pendingPermissions = new Map<string, PendingPermissionEntry>();
  private readonly resolvedEntries: PendingInteractionEntry[] = [];
  private readonly questionWaiters = new Map<string, QuestionWaiter>();

  constructor(private readonly deps: InteractionManagerOptions) {}

  /** 登记一条待回复问答条目（登记即持久化 + 发射 `sandore/question`）。 */
  addPendingQuestion(entry: PendingQuestionEntry): void {
    this.pendingQuestions.set(entry.requestId, entry);
    this.syncState();
    this.deps.emitQuestion(entry);
  }

  /** 登记一条待回复权限条目（登记即持久化 + 发射 `sandore/permission`，无自动审批）。 */
  addPendingPermission(entry: PendingPermissionEntry): void {
    this.pendingPermissions.set(entry.requestId, entry);
    this.syncState();
    this.deps.emitPermission(entry);
  }

  /**
   * 引擎级 ask 主通道：登记 → `ctx.userQuestions.ask`（hostAgent 身份）→ await 答案。
   *
   * 无 `userQuestions`（卡片通道不可用）时挂起，仅能由 {@link replyQuestion} 兼容
   * 路径 resolve。返回前条目已终态化（status=replied + answer）并持久化。
   * @param input - pending 条目与可选取消信号。
   * @returns 用户整批回答。
   */
  async ask(input: { entry: PendingQuestionEntry; signal?: AbortSignal }): Promise<AskUserQuestionAnswer> {
    const { entry, signal } = input;
    this.addPendingQuestion(entry);
    const answer = await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      this.questionWaiters.set(entry.requestId, { resolve, reject });
      const userQuestions = this.deps.userQuestions();
      if (userQuestions !== undefined) {
        void userQuestions.ask({
          questions: toAskItems(entry.payload),
          agent: this.deps.hostAgent,
          ...(signal === undefined ? {} : { signal }),
        }).then(
          (result) => this.finishQuestion(entry, result),
          (error: unknown) => this.failQuestion(entry, error),
        );
      }
    });
    return answer;
  }

  /**
   * 兼容回复路径：resolve 内部等待 Promise（与 ask 的 await 汇合）并终态化条目。
   *
   * 未知或已 replied 的 requestId 抛 {@link SandoreError}（`INVALID_OPERATION`）。
   * @param requestId - 待回复请求关联 ID。
   * @param answer - 用户整批回答。
   */
  async replyQuestion(requestId: string, answer: AskUserQuestionAnswer): Promise<void> {
    const entry = this.pendingQuestions.get(requestId);
    if (entry === undefined) {
      throw new SandoreError(`pending question '${requestId}' not found or already replied`, 'INVALID_OPERATION');
    }
    this.finishQuestion(entry, answer);
  }

  /**
   * 兼容回复路径：按 reply 取值终态化权限条目（once/always → replied，reject → rejected）。
   *
   * 不实现 permissionMode/自动审批；未知或已回复的 requestId 抛 `INVALID_OPERATION`。
   * @param requestId - 待回复请求关联 ID。
   * @param reply - 权限决定。
   */
  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const entry = this.pendingPermissions.get(requestId);
    if (entry === undefined) {
      throw new SandoreError(`pending permission '${requestId}' not found or already replied`, 'INVALID_OPERATION');
    }
    this.pendingPermissions.delete(requestId);
    this.resolvedEntries.push({
      ...entry,
      status: reply === 'reject' ? 'rejected' : 'replied',
      answer: reply,
    });
    this.syncState();
  }

  /**
   * 子代理 ask 转接：final result 含合法标记块时转引擎级 ask，答案 followup 注回子代理。
   *
   * 无合法标记块时按普通输出处理（不转接、不报错）。
   * @param input - 子代理 childId、final result、以及构造 pending 条目的定位字段。
   * @returns 是否发生转接。
   */
  async delegateSubagentAsk(input: {
    childId: string;
    output: ContentBlock[];
    stageId: string;
    stepId: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{ delegated: boolean }> {
    const payload = parseDelegatedAsk(textOf(input.output));
    if (payload === undefined) {
      return { delegated: false };
    }
    const requestId = makeRequestId();
    const entry: PendingQuestionEntry = {
      id: requestId,
      stageId: input.stageId,
      stepId: input.stepId,
      sessionId: input.sessionId,
      requestId,
      kind: 'question',
      status: 'pending',
      payload,
      createdAt: new Date().toISOString(),
    };
    const answer = await this.ask({ entry, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    await this.deps.followup(input.childId, [{ type: 'text', text: JSON.stringify(answer) }]);
    return { delegated: true };
  }

  /** 终态化一条问答条目并 resolve 其等待 Promise（幂等，兼容卡片/兼容路径竞态）。 */
  private finishQuestion(entry: PendingQuestionEntry, answer: AskUserQuestionAnswer): void {
    if (this.pendingQuestions.get(entry.requestId) === undefined) {
      return;
    }
    this.pendingQuestions.delete(entry.requestId);
    this.resolvedEntries.push({ ...entry, status: 'replied', answer: toAnswerArray(answer) });
    this.syncState();
    const waiter = this.questionWaiters.get(entry.requestId);
    this.questionWaiters.delete(entry.requestId);
    waiter?.resolve(answer);
  }

  /** 卡片 ask 失败（取消/拒绝）时清理 pending 条目并拒绝其等待 Promise。 */
  private failQuestion(entry: PendingQuestionEntry, error: unknown): void {
    if (this.pendingQuestions.get(entry.requestId) === undefined) {
      return;
    }
    this.pendingQuestions.delete(entry.requestId);
    this.resolvedEntries.push({ ...entry, status: 'rejected' });
    this.syncState();
    const waiter = this.questionWaiters.get(entry.requestId);
    this.questionWaiters.delete(entry.requestId);
    waiter?.reject(error);
  }

  /**
   * 把活跃 pending 条目镜像持久化到状态快照（**只含 pending**，不含终态历史）。
   *
   * 探索修正（2026-08）：原实现持久化 pending + resolvedEntries 全量历史，前端
   * `partitionInteractions` 不筛 status → 回答/批准后 5s 轮询再次弹出接管面板，
   * 二次提交抛 INVALID_OPERATION 无法关闭。终态条目不再进快照（历史由 userMessages
   * 与 executedSteps 承载）；resolvedEntries 仅保留内存作审计。
   */
  private syncState(): void {
    const entries: PendingInteractionEntry[] = [
      ...this.pendingQuestions.values(),
      ...this.pendingPermissions.values(),
    ];
    this.deps.persist(entries);
  }
}
