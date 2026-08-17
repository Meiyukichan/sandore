import { describeError, isCancellationError, textSummary } from "./internal.js";
import { StepRunner } from "./step-runner.js";
/** 为单个 Step 合成占位 childId（`step-{stepId}-{execId 前 8 位}`）。 */
function synthesizeChildId(stepId) {
    const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `step-${stepId}-${execId}`;
}
/** 收集 Stage 内全部 Step 定义的透传变量（steps 为合并后的完整 Step）。 */
function collectPassThroughVars(steps) {
    const result = {};
    for (const step of steps) {
        for (const passThroughVar of step.passThroughVars ?? []) {
            result[passThroughVar.name] = toPassThroughValue(passThroughVar);
        }
    }
    return result;
}
/** 将 Step 定义的透传变量转换为运行时值。 */
function toPassThroughValue(passThroughVar) {
    return {
        value: passThroughVar.value,
        description: passThroughVar.description,
        ...(passThroughVar.refresh === undefined ? {} : { refresh: passThroughVar.refresh }),
    };
}
/** 透传变量运行时值 → 字符串映射（供 shell/prompt 注入）。 */
function toVarMap(vars) {
    const result = {};
    for (const [name, value] of Object.entries(vars)) {
        result[name] = value.value;
    }
    return result;
}
/** 将已完成 Step 映射为 prompt 参考信息。 */
function toPreviousOutput(step) {
    return {
        name: step.name,
        id: step.stepId ?? step.id,
        returnPrompt: textSummary(step.output),
        files: [],
    };
}
/** 组装 Stage 产物契约。 */
function finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail) {
    const artifacts = [];
    for (const step of executedSteps) {
        for (const outputTo of step.outputTo ?? []) {
            const returnPrompt = textSummary(step.output);
            artifacts.push({
                stepId: step.stepId ?? step.id,
                outputToId: outputTo.id,
                files: [],
                ...(returnPrompt === '' ? {} : { returnPrompt }),
            });
        }
    }
    return {
        stageId: stageDef.id,
        stageName: stageDef.name,
        status,
        artifacts,
        passThroughVars,
        contractArtifacts: {},
        completedAt: new Date().toISOString(),
        ...(errorDetail === undefined ? {} : { errorDetail }),
    };
}
/** 三级门禁浅合并（workflow → stage → step，后者覆盖前者）。 */
function mergeGates(workflowDef, stageDef, step) {
    const workflowGates = workflowDef.gates;
    const stageGates = stageDef.gates;
    const stepGates = step.gates;
    if (workflowGates === undefined && stageGates === undefined && stepGates === undefined) {
        return undefined;
    }
    return {
        ...(workflowGates ?? {}),
        ...(stageGates ?? {}),
        ...(stepGates ?? {}),
    };
}
export class StageExecutor {
    options;
    runner;
    runState;
    /** step.id → 真实子代理 SessionId（经 onChildStarted 记录，取消类错误判定暂停用）。 */
    realChildIds = new Map();
    /** 本 Stage 的完整 Step（按 id 合并 stages[].steps 流控 + 顶层 steps 完整定义，含 branches）。 */
    steps;
    constructor(options) {
        this.options = options;
        this.runner = new StepRunner(options.ctx, this.trackChildStarted(options.runnerConfig));
        // 分离式合并：stage.steps 提供 id + 流控（branches），definition.steps 提供完整定义
        // （command/映射/gates 等），按 id 合并成执行用的完整 WorkflowStep。
        const definitions = new Map((options.workflowDef.steps ?? []).map(step => [step.id, step]));
        this.steps = options.stageDef.steps.map(flowStep => {
            const definition = definitions.get(flowStep.id);
            return definition === undefined
                ? flowStep
                : { ...definition, ...(flowStep.branches === undefined ? {} : { branches: flowStep.branches }) };
        });
    }
    /** 包装 onChildStarted：记录真实 childId（供取消类错误查暂停登记表），再透传原回调。 */
    trackChildStarted(runnerConfig) {
        const onChildStarted = runnerConfig.onChildStarted;
        if (onChildStarted === undefined) {
            return runnerConfig;
        }
        return {
            ...runnerConfig,
            onChildStarted: (stepId, childId) => {
                this.realChildIds.set(stepId, childId);
                onChildStarted(stepId, childId);
            },
        };
    }
    /**
     * 执行本 Stage 内全部 Step（DAG 调度循环）。
     *
     * 首次调用初始化断点续跑状态；ask 中断返回 `interacting` 后，引擎回复用户再次调用
     * 本方法即从断点续跑（重跑门禁 + 推进剩余 Step），直至 completed/failed。
     */
    async execute() {
        let state = this.runState;
        if (state === undefined) {
            state = this.initState();
            this.runState = state;
        }
        if (state.pendingPaused !== undefined) {
            const resumed = await this.resumePendingPaused(state);
            if (resumed !== 'ok') {
                // ask 中断（续跑收尾判定为 ask）或 failed：返回结果，交由引擎 ask/失败循环处理。
                return this.buildResult(state);
            }
        }
        if (state.pendingResume !== undefined) {
            const resumed = await this.resumePendingResume(state);
            if (resumed !== 'ok') {
                return this.buildResult(state);
            }
        }
        if (state.pendingAsk !== undefined) {
            const resumed = await this.resumePendingAsk(state);
            if (resumed === 'failed') {
                return this.buildResult(state);
            }
        }
        await this.runLoop(state);
        return this.buildResult(state);
    }
    /** 初始化断点续跑状态（首次调用 execute 时）。 */
    initState() {
        const { input } = this.options;
        const stepIndex = new Map();
        for (const step of this.steps) {
            stepIndex.set(step.id, step);
        }
        const passThroughVars = {
            ...input.passThroughVars,
            ...collectPassThroughVars(this.steps),
        };
        // 崩溃恢复/重试续跑播种：跳过已完成 Step，续跑指定子代理 Step（原 executed 条目复用）。
        const resumeFrom = this.options.resumeFrom;
        if (resumeFrom !== undefined) {
            const { completedSteps, resumeSubagent } = resumeFrom;
            return {
                stepIndex,
                executedSteps: [...completedSteps],
                previousOutputs: completedSteps.map(toPreviousOutput),
                passThroughVars,
                batch: [],
                batchIndex: 0,
                nextBatch: [],
                status: 'running',
                errorDetail: undefined,
                pendingAsk: undefined,
                pendingPaused: undefined,
                pendingResume: {
                    nodeId: resumeSubagent.step.id,
                    step: resumeSubagent.step,
                    executed: resumeSubagent.executed,
                    childId: resumeSubagent.childId,
                },
            };
        }
        const batch = [];
        const firstStep = this.steps[0];
        if (firstStep !== undefined) {
            batch.push(firstStep.id);
        }
        return {
            stepIndex,
            executedSteps: [],
            previousOutputs: [],
            passThroughVars,
            batch,
            batchIndex: 0,
            nextBatch: [],
            status: 'completed',
            errorDetail: undefined,
            pendingAsk: undefined,
            pendingPaused: undefined,
            pendingResume: undefined,
        };
    }
    /** 组装调度上下文（透传变量字符串映射 + 访问计数 + 取消信号）。 */
    buildContext(state) {
        const { signal, visitCounts } = this.options;
        return {
            visitCounts,
            passThroughVars: toVarMap(state.passThroughVars),
            ...(signal === undefined ? {} : { signal }),
        };
    }
    /** 主调度循环：逐批推进，遇到 ask/failed 停止（状态保留在 runState 供续跑）。 */
    async runLoop(state) {
        // 崩溃恢复/重试续跑：resume 收尾已把剩余 Step 写入 nextBatch，而 batch 为空，
        // 需先晋升 nextBatch 为 batch 才能继续推进（正常首轮 batch 非空时此分支无副作用）。
        if (state.batch.length === 0) {
            state.batch = [...new Set(state.nextBatch)];
            state.nextBatch = [];
            state.batchIndex = 0;
        }
        while (state.batch.length > 0) {
            while (state.batchIndex < state.batch.length) {
                const nodeId = state.batch[state.batchIndex];
                state.batchIndex += 1;
                const step = state.stepIndex.get(nodeId);
                if (step === undefined) {
                    // 跨阶段或 Stage 级目标：由引擎 tryAdvanceStage 承接。
                    continue;
                }
                const isRoutingNode = step.command === undefined && step.branches !== undefined;
                if (isRoutingNode) {
                    await this.processRoutingNode(nodeId, step, state);
                    continue;
                }
                const outcome = await this.processCommandNode(nodeId, step, state);
                if (outcome === 'ask' || outcome === 'failed' || outcome === 'paused') {
                    return;
                }
            }
            state.batch = [...new Set(state.nextBatch)];
            state.nextBatch = [];
            state.batchIndex = 0;
        }
    }
    /** 路由节点：resolveNextNodes 产出下一批，分支/循环评估现场回写路由条目。 */
    async processRoutingNode(nodeId, step, state) {
        const { stageDef, loopManager, resolveNextNodes, visitCounts } = this.options;
        const routed = await resolveNextNodes(nodeId, this.buildContext(state));
        // 纯循环控制节点（无 command 且仅 loop 分支）平时不产生路由条目，仅在 breakCondition
        // 评估跳出（loopMeta）时回写；带 condition/并行分支的决策节点始终记录 branchMeta。
        const isLoopControl = step.command === undefined
            && (step.branches ?? []).every(branch => branch.loop !== undefined);
        const hasBranchMeta = routed.branchMeta !== undefined;
        const hasLoopMeta = routed.loopMeta !== undefined;
        if (!isLoopControl || hasBranchMeta || hasLoopMeta) {
            const inLoopRouting = loopManager.buildLoopIterationPath().length > 0;
            const routingChildId = inLoopRouting ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
            const routingEntry = {
                type: 'default',
                id: routingChildId,
                stepId: step.id,
                stageId: stageDef.id,
                name: step.name ?? step.id,
                status: 'completed',
                visitCount: (visitCounts[nodeId] ?? 0) + 1,
                ...(inLoopRouting ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
                ...(hasBranchMeta ? { branchMeta: routed.branchMeta } : {}),
                ...(hasLoopMeta ? { loopMeta: routed.loopMeta } : {}),
            };
            visitCounts[nodeId] = routingEntry.visitCount;
            state.executedSteps.push(routingEntry);
            await this.options.onPersist?.(routingEntry);
        }
        state.nextBatch.push(...routed.nextNodeIds);
    }
    /** 命令节点：run + finalize + resolveNextNodes；ask 中断 / 失败 / 暂停时返回对应标记。 */
    async processCommandNode(nodeId, step, state) {
        const { stageDef, input, sharedState, signal, hooks, loopManager, visitCounts } = this.options;
        const command = step.command;
        const inLoop = loopManager.buildLoopIterationPath().length > 0;
        const childId = inLoop ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
        const executed = {
            type: 'default',
            id: childId,
            stepId: step.id,
            stageId: stageDef.id,
            name: step.name ?? step.id,
            status: 'running',
            ...(command === undefined ? {} : { command }),
            ...(step.inputFrom === undefined ? {} : { inputFrom: step.inputFrom }),
            ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
            ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
            ...(command === undefined
                ? {}
                : { sessionMeta: { childId, synthetic: true, command: command.type } }),
            visitCount: (visitCounts[nodeId] ?? 0) + 1,
            ...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
        };
        visitCounts[nodeId] = executed.visitCount;
        hooks?.onStepStart(step, childId);
        // 持久化 running 快照（暂停定位与崩溃恢复需要 executedSteps 含运行中 Step）。
        await this.options.onPersist?.(executed);
        if (command === undefined) {
            const message = `step '${step.id}' has no command`;
            executed.status = 'failed';
            executed.error = message;
            state.executedSteps.push(executed);
            hooks?.onStepFailed(step, childId, message);
            await this.options.onPersist?.(executed);
            state.status = 'failed';
            state.errorDetail = message;
            return 'failed';
        }
        try {
            const loopContext = loopManager.getLoopIterationContext();
            const result = await this.runner.run({
                step,
                workdir: sharedState.cwd,
                originalInput: input.originalInput,
                previousOutputs: state.previousOutputs,
                passThroughVars: toVarMap(state.passThroughVars),
                stageId: stageDef.id,
                loopTurn: loopContext.loopTurn,
                loopMaxIterations: loopContext.loopMaxIterations,
                ...(signal === undefined ? {} : { signal }),
            });
            return await this.finishCommandNode(nodeId, step, childId, executed, result, state);
        }
        catch (error) {
            // 取消类错误：`interrupt` 打断 whenIdle/执行 Promise 时以取消结束。查暂停登记表
            // 命中 → Step 保持 paused（不落 failed、不发 step-failed）；未命中 → 按失败处理。
            if (isCancellationError(error) && this.isPausedStep(step.id)) {
                executed.status = 'paused';
                state.executedSteps.push(executed);
                state.status = 'paused';
                state.pendingPaused = { nodeId, step, executed, childId: this.realChildIds.get(step.id) ?? childId };
                return 'paused';
            }
            const message = describeError(error);
            executed.status = 'failed';
            executed.error = message;
            // 失败时同步真实子代理 childId（onChildStarted 已记录），供重试/暂停反查真实 child 续跑。
            const realChildId = this.realChildIds.get(step.id);
            if (executed.sessionMeta !== undefined && realChildId !== undefined) {
                executed.sessionMeta = { ...executed.sessionMeta, childId: realChildId, synthetic: false };
            }
            state.executedSteps.push(executed);
            hooks?.onStepFailed(step, realChildId ?? childId, message);
            await this.options.onPersist?.(executed);
            state.status = 'failed';
            state.errorDetail = message;
            return 'failed';
        }
    }
    /**
     * 命令节点执行成功后的公共收尾：回填输出/会话元数据 → 收尾（finalize）→ ask 中断 /
     * 失败 / 推进下一批。首次执行、暂停续跑与崩溃恢复/重试续跑共用：`executed` 仅在尚未
     * 进入 executedSteps 时纳入（按唯一执行 id 去重），暂停续跑已在列表中则原地复用。
     */
    async finishCommandNode(nodeId, step, childId, executed, result, state) {
        const { stageDef, input, sharedState, signal, hooks, finalizeManager, resolveNextNodes } = this.options;
        executed.status = 'completed';
        executed.output = result.output;
        if (result.sessionMeta !== undefined) {
            executed.sessionMeta = {
                childId: result.sessionMeta.childId ?? childId,
                synthetic: result.sessionMeta.synthetic,
                command: result.sessionMeta.command,
            };
        }
        if (!state.executedSteps.some(item => item.id === executed.id)) {
            state.executedSteps.push(executed);
        }
        state.previousOutputs.push(toPreviousOutput(executed));
        hooks?.onStepCompleted(step, result.sessionMeta?.childId ?? childId, result.output);
        const gates = mergeGates(this.options.workflowDef, stageDef, step);
        const finalizeOutcome = await finalizeManager.finalizeStep({
            step,
            executedStep: executed,
            ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
            context: { input: input.originalInput, output: textSummary(executed.output) },
            ...(gates === undefined ? {} : { gates }),
            workdir: sharedState.cwd,
            passThroughVars: state.passThroughVars,
            ...(signal === undefined ? {} : { signal }),
        });
        if (finalizeOutcome.type === 'ask') {
            // ask 中断：保留断点（剩余 Step 不丢失），等待引擎 ask 回复后续跑。
            await this.options.onPersist?.(executed);
            state.pendingAsk = { nodeId, step, executed, assessResult: finalizeOutcome.assessResult };
            state.status = 'interacting';
            return 'ask';
        }
        if (finalizeOutcome.type === 'error') {
            const message = finalizeOutcome.errorDetail;
            executed.status = 'failed';
            executed.error = message;
            hooks?.onStepFailed(step, result.sessionMeta?.childId ?? childId, message);
            await this.options.onPersist?.(executed);
            state.status = 'failed';
            state.errorDetail = message;
            return 'failed';
        }
        const routed = await resolveNextNodes(nodeId, this.buildContext(state));
        if (routed.branchMeta !== undefined) {
            executed.branchMeta = routed.branchMeta;
        }
        if (routed.loopMeta !== undefined) {
            executed.loopMeta = routed.loopMeta;
        }
        await this.options.onPersist?.(executed);
        state.nextBatch.push(...routed.nextNodeIds);
        state.status = 'completed';
        return 'ok';
    }
    /** pause 后从断点续跑：重新收集子代理输出（whenIdle + final output），随后走公共收尾。 */
    async resumePendingPaused(state) {
        const pending = state.pendingPaused;
        state.pendingPaused = undefined;
        return this.resumeSubagentStep(state, pending.nodeId, pending.step, pending.executed, pending.childId);
    }
    /** 崩溃恢复/重试续跑：重新收集子代理输出（whenIdle + final output），随后走公共收尾。 */
    async resumePendingResume(state) {
        const pending = state.pendingResume;
        state.pendingResume = undefined;
        return this.resumeSubagentStep(state, pending.nodeId, pending.step, pending.executed, pending.childId);
    }
    /** 续跑子代理 Step 的公共尾段：重新收集输出 + 公共收尾（finishCommandNode）。 */
    async resumeSubagentStep(state, nodeId, step, executed, childId) {
        const command = step.command;
        if (command === undefined || (command.type !== 'agent' && command.type !== 'skill' && command.type !== 'mcp')) {
            // 理论不可达：续跑仅对子代理 Step 生效（shell/prompt 由 recovery/lifecycle 守卫拦截）。
            const message = `step '${step.id}' is not a resumable subagent step`;
            executed.status = 'failed';
            executed.error = message;
            await this.options.onPersist?.(executed);
            state.status = 'failed';
            state.errorDetail = message;
            return 'failed';
        }
        const result = await this.runner.resumeSubagent(command.type, childId, step.id, this.options.stageDef.id);
        return this.finishCommandNode(nodeId, step, childId, executed, result, state);
    }
    /** 取消类错误下，Step 是否命中暂停登记表（真实 childId 已暂停 → 保持 paused）。 */
    isPausedStep(stepId) {
        const childId = this.realChildIds.get(stepId);
        if (childId === undefined) {
            return false;
        }
        return this.options.runnerConfig.isPausedChild?.(childId) === true;
    }
    /** ask 回复后从断点续跑：重跑门禁审查，随后推进下一批节点。 */
    async resumePendingAsk(state) {
        const { stageDef, input, sharedState, signal, hooks, finalizeManager, resolveNextNodes } = this.options;
        const pending = state.pendingAsk;
        state.pendingAsk = undefined;
        const { nodeId, step, executed, assessResult } = pending;
        const gates = mergeGates(this.options.workflowDef, stageDef, step);
        const finalizeOutcome = await finalizeManager.finalizeStepAfterAsk({
            step,
            executedStep: executed,
            ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
            context: { input: input.originalInput, output: textSummary(executed.output) },
            ...(gates === undefined ? {} : { gates }),
            workdir: sharedState.cwd,
            passThroughVars: state.passThroughVars,
            ...(signal === undefined ? {} : { signal }),
        }, assessResult);
        if (finalizeOutcome.type === 'error') {
            const message = finalizeOutcome.errorDetail;
            executed.status = 'failed';
            executed.error = message;
            hooks?.onStepFailed(step, executed.sessionMeta?.childId ?? executed.id, message);
            await this.options.onPersist?.(executed);
            state.status = 'failed';
            state.errorDetail = message;
            return 'failed';
        }
        // 门禁通过：状态回到 completed，resolveNextNodes 推进下一批。
        state.status = 'completed';
        const routed = await resolveNextNodes(nodeId, this.buildContext(state));
        if (routed.branchMeta !== undefined) {
            executed.branchMeta = routed.branchMeta;
        }
        if (routed.loopMeta !== undefined) {
            executed.loopMeta = routed.loopMeta;
        }
        await this.options.onPersist?.(executed);
        state.nextBatch.push(...routed.nextNodeIds);
        return 'ok';
    }
    /** 组装 Stage 执行结果。 */
    buildResult(state) {
        const stageContract = finalizeStageContract(this.options.stageDef, state.executedSteps, state.status, state.passThroughVars, state.errorDetail);
        return {
            stageContract,
            executedSteps: state.executedSteps,
            passThroughVars: state.passThroughVars,
            status: state.status,
            ...(state.errorDetail === undefined ? {} : { errorDetail: state.errorDetail }),
        };
    }
}
//# sourceMappingURL=stage-executor.js.map