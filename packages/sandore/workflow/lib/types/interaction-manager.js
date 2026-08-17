import { SandoreError } from "./errors.js";
import { AskUserQuestionPayloadSchema } from "./schema.js";
/** 子代理 ask 标记块起止定界。 */
const ASK_MARKER_START = '[[SANDORE_ASK]]';
const ASK_MARKER_END = '[[/SANDORE_ASK]]';
/** 生成请求关联 ID。 */
function makeRequestId() {
    return globalThis.crypto.randomUUID();
}
/** 提取 ContentBlock[] 中的纯文本（仅 text 块）。 */
function textOf(output) {
    const texts = [];
    for (const block of output) {
        if (block.type === 'text') {
            texts.push(block.text);
        }
    }
    return texts.join('\n');
}
/** 蛇形 `AskUserQuestionPayload` → 驼峰 `AskUserQuestionItem[]`（对齐 DSH）。 */
function toAskItems(payload) {
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
function toAnswerArray(answer) {
    return answer.answers.map(item => item.selected);
}
/**
 * 解析子代理 final result 中的保守标记块 `[[SANDORE_ASK]]{...json...}[[/SANDORE_ASK]]`。
 *
 * 仅解析首个标记块；JSON 解析失败、`AskUserQuestionPayloadSchema` 校验不通过或
 * `questions` 为空均返回 `undefined`（按普通输出处理，不转接）。
 * @param text - 子代理 final result 的纯文本。
 * @returns 合法 ask 载荷，或无合法标记块时为 `undefined`。
 */
export function parseDelegatedAsk(text) {
    const start = text.indexOf(ASK_MARKER_START);
    if (start < 0) {
        return undefined;
    }
    const jsonStart = start + ASK_MARKER_START.length;
    const end = text.indexOf(ASK_MARKER_END, jsonStart);
    if (end < 0) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(text.slice(jsonStart, end));
    }
    catch {
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
    deps;
    pendingQuestions = new Map();
    pendingPermissions = new Map();
    resolvedEntries = [];
    questionWaiters = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** 登记一条待回复问答条目（登记即持久化 + 发射 `sandore/question`）。 */
    addPendingQuestion(entry) {
        this.pendingQuestions.set(entry.requestId, entry);
        this.syncState();
        this.deps.emitQuestion(entry);
    }
    /** 登记一条待回复权限条目（登记即持久化 + 发射 `sandore/permission`，无自动审批）。 */
    addPendingPermission(entry) {
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
    async ask(input) {
        const { entry, signal } = input;
        this.addPendingQuestion(entry);
        const answer = await new Promise((resolve, reject) => {
            this.questionWaiters.set(entry.requestId, { resolve, reject });
            const userQuestions = this.deps.userQuestions();
            if (userQuestions !== undefined) {
                void userQuestions.ask({
                    questions: toAskItems(entry.payload),
                    agent: this.deps.hostAgent,
                    ...(signal === undefined ? {} : { signal }),
                }).then((result) => this.finishQuestion(entry, result), (error) => this.failQuestion(entry, error));
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
    async replyQuestion(requestId, answer) {
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
    async replyPermission(requestId, reply) {
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
    async delegateSubagentAsk(input) {
        const payload = parseDelegatedAsk(textOf(input.output));
        if (payload === undefined) {
            return { delegated: false };
        }
        const requestId = makeRequestId();
        const entry = {
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
    finishQuestion(entry, answer) {
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
    failQuestion(entry, error) {
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
    /** 把活跃 pending + 终态历史全量镜像持久化到状态快照。 */
    syncState() {
        const entries = [
            ...this.pendingQuestions.values(),
            ...this.pendingPermissions.values(),
            ...this.resolvedEntries,
        ];
        this.deps.persist(entries);
    }
}
//# sourceMappingURL=interaction-manager.js.map