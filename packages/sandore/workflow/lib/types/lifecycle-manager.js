import { SandoreError } from "./errors.js";
/** Step 终态集合：暂停对终态 Step 抛 `INVALID_OPERATION`。 */
const TERMINAL_STEP_STATUSES = new Set(['completed', 'failed']);
/** 恢复提示词的缺省值（`resumeStep`/`resumeAllSteps` 未显式提供时使用）。 */
const DEFAULT_RESUME_PROMPT = '请继续完成当前任务。';
/** 合成新子代理 SessionId（与 shell/prompt 的 `synthesizeChildId` 同规则）。 */
export function synthesizeChildId(stepId) {
    const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `step-${stepId}-${execId}`;
}
/** 当前 ISO 时间戳。 */
function now() {
    return new Date().toISOString();
}
/**
 * 生命周期协调器。
 *
 * 持有暂停登记表（内存 `Set`），通过注入的依赖驱动单步/全局暂停与恢复；状态更新
 * 以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
 */
export class LifecycleManager {
    deps;
    pausedChildIds;
    constructor(deps) {
        this.deps = deps;
        this.pausedChildIds = new Set(deps.initialPausedChildIds);
    }
    /** 暂停登记表当前内容（子代理 SessionId 集合，仅只读投影）。 */
    get pausedIds() {
        return [...this.pausedChildIds];
    }
    /**
     * 子代理自然完成（interrupt 软信号未生效，Step 已 completed）时清理暂停登记表：
     * 移除该 childId 并同步持久化。pause→完成竞态（pauseStep 先 interrupt+登记，但子代理
     * 仍跑完）后，若不清登记会残留「段 completed + 登记表有值」的不一致，resume 将卡死。
     * @param childId - 已完成的子代理 SessionId。
     */
    clearPausedOnCompletion(childId) {
        if (!this.pausedChildIds.has(childId)) {
            return;
        }
        this.pausedChildIds.delete(childId);
        this.commitPausedRegistry();
    }
    /** 某子代理 SessionId 是否在暂停登记表中。 */
    hasPaused(childId) {
        return this.pausedChildIds.has(childId);
    }
    /** 暂停单个 Step（经 childId 反查 + interrupt + 登记表 add + 状态 paused + 事件）。 */
    pauseStep(stepId) {
        const step = this.findStep(stepId);
        if (step === undefined) {
            throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
        }
        if (this.isNonSubagentCommand(step)) {
            // shell/prompt Step（sessionMeta.synthetic 合成占位，无真实子代理）不可暂停：
            // interrupt 一个无活代理 id 是静默 no-op，会误标 paused（假暂停）。直接拒绝。
            throw new SandoreError(`step '${stepId}' is a non-subagent step (${step.command?.type}) and cannot be paused`, 'INVALID_OPERATION');
        }
        if (TERMINAL_STEP_STATUSES.has(step.status)) {
            throw new SandoreError(`step '${stepId}' is in terminal state '${step.status}'`, 'INVALID_OPERATION');
        }
        const childId = this.childIdOf(step);
        if (this.pausedChildIds.has(childId)) {
            // 已在登记表：重复暂停幂等 no-op（避免重复 interrupt / 重复标记）。
            return;
        }
        const child = this.deps.getAgent(childId);
        if (child !== undefined && child.status === 'idle' && !child.inbox.hasPending) {
            // 目标子代理恰好在 interrupt 前完成（空闲且 inbox 无 pending）：幂等 no-op，
            // 不产生中断副作用、不误标 paused（按 Step 实际完成状态处理）。
            return;
        }
        this.deps.interrupt(childId, { kind: 'ancestor', agent: this.deps.hostAgent });
        this.pausedChildIds.add(childId);
        this.commitStepStatus(step, 'paused', { pausedAt: now() });
        this.deps.emitStepPaused(this.stepIdOf(step), childId, step.name, step.loopIteration);
    }
    /**
     * 恢复单个 Step（反查 childId + 移出登记表 + followup + 追加新执行段 + 用户消息）。
     *
     * 段模型：被暂停段保持 paused 定格快照；恢复时以它为基底创建**新执行段**
     * （新唯一执行 id + attemptIndex+1 + createdAt），followup 唤醒同一子代理续跑。
     * 恢复消息不写入段（统一存 `userMessages`，避免广播时每段重复同一句话）。
     */
    async resumeStep(stepId, resumePrompt) {
        const step = this.findStep(stepId);
        if (step === undefined) {
            throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
        }
        const childId = this.childIdOf(step);
        if (!this.pausedChildIds.has(childId)) {
            throw new SandoreError(`step '${stepId}' is not paused`, 'INVALID_OPERATION');
        }
        const content = [{ type: 'text', text: resumePrompt ?? DEFAULT_RESUME_PROMPT }];
        await this.deps.followup(childId, content, this.deps.signal);
        this.pausedChildIds.delete(childId);
        // 段创建权归执行器（stage-executor resumePendingPaused 基于旧段新建段对象）；
        // lifecycle 只负责 followup + 登记表 + 用户消息 + 事件。段内不写 resumePrompt。
        this.deps.appendUserMessage(this.userMessage('resume', this.stepIdOf(step), resumePrompt ?? DEFAULT_RESUME_PROMPT));
        this.commitPausedRegistry();
        this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt, step.name, step.loopIteration);
    }
    /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
    pauseAllSteps() {
        const targets = this.deps.readState().executedSteps.filter(step => (step.status === 'running' || step.status === 'interacting') &&
            !this.isNonSubagentCommand(step));
        for (const step of targets) {
            this.pauseStep(this.stepIdOf(step));
        }
    }
    /**
     * 恢复登记表内全部 Step（逐个 followup + 移表，完成后登记表清空）。
     * 广播指令是实例级事件：只追加一条 `target:'broadcast'` 用户消息（不得复制进每个 Step）。
     */
    async resumeAllSteps(resumePrompt) {
        const childIds = [...this.pausedChildIds];
        for (const childId of childIds) {
            const step = this.findStepByChildId(childId);
            if (step === undefined) {
                continue;
            }
            const content = [{ type: 'text', text: resumePrompt ?? DEFAULT_RESUME_PROMPT }];
            await this.deps.followup(childId, content, this.deps.signal);
            this.pausedChildIds.delete(childId);
            // 段创建由执行器续跑完成（resumePendingPaused）；此处只发事件（含 Step 名称）。
            this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt, step.name, step.loopIteration);
        }
        if (childIds.length > 0) {
            this.deps.appendUserMessage(this.userMessage('resume', 'broadcast', resumePrompt ?? DEFAULT_RESUME_PROMPT));
            this.commitPausedRegistry();
        }
    }
    /** 登记表变更后同步持久化（pausedChildIds + 实例 status；空表 → running）。 */
    commitPausedRegistry() {
        const state = this.deps.readState();
        const next = {
            ...state,
            status: this.pausedChildIds.size > 0 ? 'paused' : 'running',
            pausedChildIds: [...this.pausedChildIds],
            updatedAt: now(),
        };
        this.deps.commitState(next);
    }
    /**
     * 按 stepId（定义 id 或唯一执行 id）反查"最后活跃段"（status running/interacting 中
     * attemptIndex 最大者）；无活跃段时回退同 stepId 的任意段（再退唯一执行 id）。
     * 段模型下同 step 可有多段（attempt0 paused + attempt1 running），暂停/恢复必须定位活跃段。
     */
    findStep(stepId) {
        const steps = this.deps.readState().executedSteps;
        const byStep = steps.filter(step => step.stepId === stepId);
        if (byStep.length > 0) {
            const active = byStep
                .filter(step => step.status === 'running' || step.status === 'interacting')
                .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0));
            return active[0] ?? byStep[byStep.length - 1];
        }
        return steps.find(step => step.id === stepId);
    }
    /** 按子代理 SessionId 反查 Step（`resumeAllSteps` 遍历登记表用）。 */
    findStepByChildId(childId) {
        const steps = this.deps.readState().executedSteps;
        return steps.find(step => this.childIdOf(step) === childId);
    }
    /** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
    childIdOf(step) {
        return step.sessionMeta?.childId ?? step.id;
    }
    /** 判定 Step 是否为非子代理命令（shell/prompt 合成占位，无真实子代理，不可暂停）。 */
    isNonSubagentCommand(step) {
        const type = step.command?.type;
        return type === 'shell' || type === 'prompt';
    }
    /** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
    stepIdOf(step) {
        return step.stepId ?? step.id;
    }
    /** 不可变重建状态：更新单个 Step 状态 + 同步登记表 + 持久化。 */
    commitStepStatus(step, status, extra) {
        const state = this.deps.readState();
        const next = {
            ...state,
            status: this.pausedChildIds.size > 0 ? 'paused' : 'running',
            executedSteps: state.executedSteps.map(item => {
                if (item.id !== step.id) {
                    return item;
                }
                return {
                    ...item,
                    status,
                    ...(extra.pausedAt === undefined ? {} : { pausedAt: extra.pausedAt }),
                };
            }),
            pausedChildIds: [...this.pausedChildIds],
            updatedAt: now(),
        };
        this.deps.commitState(next);
    }
    /** 构造一条用户消息记录（统一时间轴）。 */
    userMessage(kind, target, content) {
        return { id: `usr-${globalThis.crypto.randomUUID()}`, kind, target, content, createdAt: now() };
    }
}
//# sourceMappingURL=lifecycle-manager.js.map