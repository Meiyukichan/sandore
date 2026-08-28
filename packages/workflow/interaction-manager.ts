/**
 * 交互管理器（引擎级 ask 主通道 + pending Map 镜像持久化 + 兼容回复路径 + 权限镜像）。
 *
 * `InteractionManager` 是「纯协调器」：维护 `pendingQuestions`/`pendingPermissions`
 * Map（requestId → 条目）与终态条目历史，在登记/回复/拒绝时经注入的
 * `persist`/`emitQuestion`/`emitPermission` 回调把结构化条目同步到
 * `WorkflowTaskState.pendingInteractions` 并双发 `sandore/question`/
 * `sandore/permission` 事件。引擎级 ask 的权威路径是 `ctx.userQuestions.ask`
 * 的 await；`replyQuestion`/`replyPermission` 是兼容回复路径（resolve 内部等待
 * Promise，与 ask 的 await 汇合），供 DSH 卡片通道不可用（如 headless 测试）时使用。
 *
 * 双通道 ask 重构后**不再承载子代理 ask 转接**（`[[SANDORE_ASK]]` 标记块机制已删）：
 * 子代理提问走 child-scope `ask_user_question` 工具（引擎 `askFromSubagent` → 本管理
 * 器 `ask` 主通道，见 workflow-engine.ts / ask-tool.ts）。
 * @module dsh-sandore/workflow/src/interaction-manager
 */
import type { Agent } from '../microflow/subagents';
import { SandoreError } from './errors.ts';
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
  /** Round 26：是否把 ask 上报宿主主代理（复用 hostSessionId 时 true；overlay 新建
   *  false——只走 discussion composer 卡，经 replyQuestion 兼容路径回答）。 */
  readonly reportToHost: boolean;
  /** 把当前 pending 条目全量镜像持久化到状态快照。 */
  readonly persist: (entries: PendingInteractionEntry[]) => void;
  /** 双发 `sandore/question` 事件（Cordis + Session append）。 */
  readonly emitQuestion: (entry: PendingQuestionEntry) => void;
  /** 双发 `sandore/permission` 事件（Cordis + Session append）。 */
  readonly emitPermission: (entry: PendingPermissionEntry) => void;
  /** 双发 `sandore/question_rejected` 事件（Cordis + Session append，缺陷 26）。 */
  readonly emitQuestionRejected: (entry: PendingQuestionEntry) => void;
}

/** 等待中的问答 Promise 解析器（`ask` 与 `replyQuestion` 汇合点）。 */
interface QuestionWaiter {
  readonly resolve: (answer: AskUserQuestionAnswer) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * 取消占位答案：`clearPendingInteractions`/`clearAll` 解挂 question waiter 用。
 *
 * **必须 resolve（非 reject）**：reject 会冒泡到 `runAndCatch` 把实例落 failed；
 * resolve 后主循环才能解挂走 paused 分支（缺陷 27 主循环路由修正，随 pause 接入
 * 一并落地）。空 `answers` 即「已取消」语义占位。
 */
const CANCELLED_ANSWER: AskUserQuestionAnswer = { answers: [] };

/**
 * 拒绝占位答案：`rejectQuestion` 解挂 question waiter 用（缺陷 26）。
 *
 * 带 `rejected: true` 标记，引擎 ask 调用处经 {@link isRejectedAnswer} 检测后标
 * Step failed（非冒泡——reject 会穿出 `runInstance` 落 `runAndCatch` 把整实例标
 * failed 且 Step 滞留 interacting）。与 {@link CANCELLED_ANSWER}（空 answers、无标记）
 * 区分：取消 = 续跑占位（缺陷 27 pause 路径），拒绝 = Step failed 语义。
 */
const REJECTED_ANSWER: AskUserQuestionAnswer & { readonly rejected: true } = {
  answers: [],
  rejected: true,
};

/**
 * 检测答案是否为 `rejectQuestion` 的拒绝占位（缺陷 26）。
 *
 * 引擎 ask 调用处 await 后调用此守卫：命中则转 Step-failed 语义，否则按正常回答
 * 处理。占位标记只在内存传递（`rejectQuestion` → waiter resolve → ask await），
 * 不经 RPC/zod 序列化，故 `rejected` 字段不会被 strip。
 */
export function isRejectedAnswer(answer: AskUserQuestionAnswer): answer is AskUserQuestionAnswer & { rejected: true } {
  return (answer as { rejected?: unknown }).rejected === true;
}

/** 生成请求关联 ID。 */
function makeRequestId(): string {
  return globalThis.crypto.randomUUID();
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
  /** Round 26：按 requestId 的 DSH 弹窗 AbortController（场景 B 同步——composer 回答 /
   *  拒绝 / 清理时主动 abort，DSH 弹窗收到 question/resolved 自动关闭）。 */
  private readonly questionAborts = new Map<string, AbortController>();

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
   * 引擎级 ask 主通道：登记 → 视场景决定是否 `ctx.userQuestions.ask`（hostAgent 身份）
   * → await 答案。
   *
   * Round 26 场景拆分：`reportToHost === true`（复用 hostSessionId）时向宿主主代理
   * 上报（DSH 弹窗）+ sandore composer 卡双通道；`false`（overlay 新建）时**不上报**
   * 宿主（不调 userQuestions.ask），仅由 {@link replyQuestion} 兼容路径（composer 卡）
   * resolve。无论是否上报，每次 ask 使用**独立内部 AbortController**（链式继承调用方
   * signal：调用方 abort → 内部 abort；finish/reject/cancel 主动 abort 关闭 DSH 弹窗
   * 时不会误杀实例/子代理）。返回前条目已终态化（status=replied + answer）并持久化。
   * @param input - pending 条目与可选取消信号。
   * @returns 用户整批回答。
   */
  async ask(input: { entry: PendingQuestionEntry; signal?: AbortSignal }): Promise<AskUserQuestionAnswer> {
    const { entry, signal } = input;
    this.addPendingQuestion(entry);
    // 每次 ask 独立 controller：主动 abort 只关本次 DSH 弹窗；调用方 signal 链式继承。
    const controller = new AbortController();
    this.questionAborts.set(entry.requestId, controller);
    const onOuterAbort = (): void => { controller.abort(); };
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        this.questionWaiters.set(entry.requestId, { resolve, reject });
        const userQuestions = this.deps.userQuestions();
        // Round 26：reportToHost=false（overlay 新建）不上报宿主——挂起等 replyQuestion。
        if (userQuestions !== undefined && this.deps.reportToHost) {
          void userQuestions.ask({
            questions: toAskItems(entry.payload),
            agent: this.deps.hostAgent,
            signal: controller.signal,
          }).then(
            (result) => this.finishQuestion(entry, result),
            (error: unknown) => this.failQuestion(entry, error),
          );
        }
      });
    } finally {
      // promise 结算后清理：移除链式监听 + 删 controller（finish/reject/cancel 的
      // abort 已在结算前同步执行）。
      signal?.removeEventListener('abort', onOuterAbort);
      this.questionAborts.delete(entry.requestId);
    }
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
   * 公开拒绝路径：按 requestId 终态化（`status:'rejected'`）+ 删 Map + **resolve**
   * （非 reject）question waiter 占位答案（{@link REJECTED_ANSWER}），供引擎 ask 调用
   * 处检测后标 Step failed（缺陷 26）。
   *
   * 镜像 {@link finishQuestion} 的幂等清理，但 resolve 等待 Promise（非 reject——避免
   * 冒泡 `runAndCatch` 把整实例落 failed 且 Step 滞留 interacting）。终态条目入
   * `resolvedEntries`（`status 'rejected'`），不进快照（与 `finishQuestion` 一致：
   * 历史由 `userMessages` 与 `executedSteps` 承载）。双发 `sandore/question_rejected`
   * 事件供 UI 刷新。未知/已终态 requestId 抛 `INVALID_OPERATION`。
   * @param requestId - 待拒绝请求关联 ID。
   */
  async rejectQuestion(requestId: string): Promise<void> {
    const entry = this.pendingQuestions.get(requestId);
    if (entry === undefined) {
      throw new SandoreError(`pending question '${requestId}' not found or already replied`, 'INVALID_OPERATION');
    }
    this.pendingQuestions.delete(requestId);
    const rejected: PendingQuestionEntry = { ...entry, status: 'rejected' };
    this.resolvedEntries.push(rejected);
    this.syncState();
    const waiter = this.questionWaiters.get(requestId);
    this.questionWaiters.delete(requestId);
    waiter?.resolve(REJECTED_ANSWER);
    // Round 26：拒绝后同步关闭宿主 DSH 弹窗（场景 B 双通道同步）。
    this.questionAborts.get(requestId)?.abort();
    this.deps.emitQuestionRejected(rejected);
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
    // Round 26：回答后同步关闭宿主 DSH 弹窗（场景 B——composer 卡回答后宿主弹窗
    // 立即 question/resolved；abort 触发 failQuestion 幂等守卫（条目已删）静默吞掉，
    // 不 reject 引擎 waiter、不冒泡 runAndCatch）。先 resolve 再 abort（同一同步栈）。
    this.questionAborts.get(entry.requestId)?.abort();
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
   * 按 stepId 批量清理 pending 交互（缺陷 27：供 pause/retry 调用）。
   *
   * 遍历 `pendingQuestions`/`pendingPermissions`，匹配 `entry.stepId`（终态化条目
   * → 入 `resolvedEntries`（status `'rejected'`）+ 删 Map + 删 `questionWaiters` 并
   * **resolve**「已取消」占位答案——reject 会冒泡到 `runAndCatch` 把实例落 failed，
   * resolve 后主循环才能解挂走 paused 分支）。`syncState` 自动重持久化 → 快照/UI 自愈。
   * @param stepId - 待清理 Step 的定义 id。
   */
  clearPendingInteractions(stepId: string): void {
    if (this.cancelMatching(entry => entry.stepId === stepId)) {
      this.syncState();
    }
  }

  /**
   * 全量清理 pending 交互（崩溃恢复用，对齐基准 recover 步骤 B `clearAll`）。
   *
   * 与 {@link clearPendingInteractions} 同语义但无 stepId 过滤：终态化全部 pending
   * 条目 + resolve 全部 waiter 占位答案。**始终** `syncState`（即使 Maps 为空），
   * 以空 pending 覆盖快照中残留的 stale `pendingInteractions`（缺陷 9 B / 缺陷 27
   * 崩溃恢复路径：InteractionManager 重建时 Maps 为空、不 hydrate，ghost 条目留在
   * 快照会被 UI 复弹且 `replyQuestion` 抛 `INVALID_OPERATION`）。
   */
  clearAll(): void {
    this.cancelMatching(() => true);
    this.syncState();
  }

  /**
   * 批量取消匹配的 pending 交互（{@link clearPendingInteractions}/`clearAll` 共用）。
   *
   * 终态化匹配条目（入 `resolvedEntries`，status `'rejected'`）+ 删 Map +
   * resolve（非 reject）question waiter 占位答案。不调用 `syncState`（由调用方按需调用，
   * `clearAll` 始终调用以覆盖 stale 快照，`clearPendingInteractions` 仅在变更时调用）。
   * @returns 是否有匹配并清理的条目（供调用方决定是否 `syncState`）。
   */
  private cancelMatching(match: (entry: PendingInteractionEntry) => boolean): boolean {
    let changed = false;
    // questions：终态化 + 删 Map + resolve waiter 占位答案（非 reject，避免冒泡 failed）。
    for (const [requestId, entry] of this.pendingQuestions) {
      if (!match(entry)) {
        continue;
      }
      this.pendingQuestions.delete(requestId);
      this.resolvedEntries.push({ ...entry, status: 'rejected' });
      const waiter = this.questionWaiters.get(requestId);
      if (waiter !== undefined) {
        this.questionWaiters.delete(requestId);
        waiter.resolve(CANCELLED_ANSWER);
      }
      // Round 26：清理时同步关闭宿主 DSH 弹窗（pause/retry/崩溃恢复路径）。
      this.questionAborts.get(requestId)?.abort();
      changed = true;
    }
    // permissions：终态化 + 删 Map（无 waiter）。
    for (const [requestId, entry] of this.pendingPermissions) {
      if (!match(entry)) {
        continue;
      }
      this.pendingPermissions.delete(requestId);
      this.resolvedEntries.push({ ...entry, status: 'rejected' });
      changed = true;
    }
    return changed;
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
