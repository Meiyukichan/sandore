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
import type { UserQuestions } from './seam.ts';
import type { AskUserQuestionAnswer, AskUserQuestionPayload, PendingPermissionEntry, PendingQuestionEntry } from './types.ts';
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
/**
 * `AskUserQuestionAnswer` → 注回子代理/写 userMessages 的可读文本。
 *
 * 每题一行：选中项 `selected` 用 `、` 连接，`custom` 自由文本追加为「（补充：…）」；
 * 无选中项仅自由文本时输出自由文本本身。空答案条目跳过。
 * @param answer - 用户整批回答。
 * @returns 多行可读文本。
 */
export declare function buildAnswerText(answer: AskUserQuestionAnswer): string;
/**
 * 解析子代理 final result 中的保守标记块 `[[SANDORE_ASK]]{...json...}[[/SANDORE_ASK]]`。
 *
 * 仅解析首个标记块；JSON 解析失败、`AskUserQuestionPayloadSchema` 校验不通过或
 * `questions` 为空均返回 `undefined`（按普通输出处理，不转接）。
 * @param text - 子代理 final result 的纯文本。
 * @returns 合法 ask 载荷，或无合法标记块时为 `undefined`。
 */
export declare function parseDelegatedAsk(text: string): AskUserQuestionPayload | undefined;
/**
 * 交互管理器。
 *
 * Map 仅维护「活跃 pending」条目（用于 reply 路由）；终态（replied/rejected）
 * 条目进入 `resolvedEntries` 历史并随每次 `syncState` 一并镜像到快照，保证
 * `pendingInteractions` 始终是「pending + 终态」的全量历史。
 */
export declare class InteractionManager {
    private readonly deps;
    private readonly pendingQuestions;
    private readonly pendingPermissions;
    private readonly resolvedEntries;
    private readonly questionWaiters;
    constructor(deps: InteractionManagerOptions);
    /** 登记一条待回复问答条目（登记即持久化 + 发射 `sandore/question`）。 */
    addPendingQuestion(entry: PendingQuestionEntry): void;
    /** 登记一条待回复权限条目（登记即持久化 + 发射 `sandore/permission`，无自动审批）。 */
    addPendingPermission(entry: PendingPermissionEntry): void;
    /**
     * 引擎级 ask 主通道：登记 → `ctx.userQuestions.ask`（hostAgent 身份）→ await 答案。
     *
     * 无 `userQuestions`（卡片通道不可用）时挂起，仅能由 {@link replyQuestion} 兼容
     * 路径 resolve。返回前条目已终态化（status=replied + answer）并持久化。
     * @param input - pending 条目与可选取消信号。
     * @returns 用户整批回答。
     */
    ask(input: {
        entry: PendingQuestionEntry;
        signal?: AbortSignal;
    }): Promise<AskUserQuestionAnswer>;
    /**
     * 兼容回复路径：resolve 内部等待 Promise（与 ask 的 await 汇合）并终态化条目。
     *
     * 未知或已 replied 的 requestId 抛 {@link SandoreError}（`INVALID_OPERATION`）。
     * @param requestId - 待回复请求关联 ID。
     * @param answer - 用户整批回答。
     */
    replyQuestion(requestId: string, answer: AskUserQuestionAnswer): Promise<void>;
    /**
     * 兼容回复路径：按 reply 取值终态化权限条目（once/always → replied，reject → rejected）。
     *
     * 不实现 permissionMode/自动审批；未知或已回复的 requestId 抛 `INVALID_OPERATION`。
     * @param requestId - 待回复请求关联 ID。
     * @param reply - 权限决定。
     */
    replyPermission(requestId: string, reply: PermissionReply): Promise<void>;
    /**
     * 子代理 ask 转接：final result 含合法标记块时转引擎级 ask，答案 followup 注回子代理。
     *
     * 无合法标记块时按普通输出处理（不转接、不报错）。
     * @param input - 子代理 childId、final result、以及构造 pending 条目的定位字段。
     * @returns 是否发生转接。
     */
    delegateSubagentAsk(input: {
        childId: string;
        output: ContentBlock[];
        stageId: string;
        stepId: string;
        sessionId: string;
        signal?: AbortSignal;
    }): Promise<{
        delegated: boolean;
    }>;
    /** 终态化一条问答条目并 resolve 其等待 Promise（幂等，兼容卡片/兼容路径竞态）。 */
    private finishQuestion;
    /** 卡片 ask 失败（取消/拒绝）时清理 pending 条目并拒绝其等待 Promise。 */
    private failQuestion;
    /**
     * 把活跃 pending 条目镜像持久化到状态快照（**只含 pending**，不含终态历史）。
     *
     * 探索修正（2026-08）：原实现持久化 pending + resolvedEntries 全量历史，前端
     * `partitionInteractions` 不筛 status → 回答/批准后 5s 轮询再次弹出接管面板，
     * 二次提交抛 INVALID_OPERATION 无法关闭。终态条目不再进快照（历史由 userMessages
     * 与 executedSteps 承载）；resolvedEntries 仅保留内存作审计。
     */
    private syncState;
}
//# sourceMappingURL=interaction-manager.d.ts.map