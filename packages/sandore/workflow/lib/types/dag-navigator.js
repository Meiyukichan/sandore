import { BranchEvaluator, extractExpectation, matchesExpectation } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import { LoopManager } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
/** 去重并保序。 */
function dedupe(ids) {
    return [...new Set(ids)];
}
export class WorkflowDagNavigator {
    definition;
    nodeIndex = new Map();
    stageContracts = new Map();
    stageOrder;
    currentStageId;
    evaluator;
    loopManager;
    constructor(definition, ctx, config, loopState, seed) {
        this.definition = definition;
        this.buildNodeIndex(definition);
        this.stageOrder = definition.stages.map(stage => stage.id);
        // 从快照播种当前 Stage（续跑入口）；缺省回退定义首个 Stage。
        this.currentStageId = seed?.currentStageId ?? this.stageOrder[0] ?? '';
        this.evaluator = new BranchEvaluator(ctx, config);
        this.loopManager = new LoopManager(ctx, config, loopState);
        if (seed?.stageContracts !== undefined) {
            for (const [id, contract] of Object.entries(seed.stageContracts)) {
                this.stageContracts.set(id, contract);
            }
        }
    }
    /** 当前 Stage ID（无 Stage 时为空字符串）。 */
    get currentNodeId() {
        return this.currentStageId;
    }
    /** 循环管理器（引擎/执行器共享，用于 ID 后缀与迭代路径）。 */
    get loopManagerInstance() {
        return this.loopManager;
    }
    /** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
    getStageContracts() {
        return new Map(this.stageContracts);
    }
    /** 查询单个 Stage 的契约。 */
    getStageContract(stageId) {
        return this.stageContracts.get(stageId);
    }
    /** 聚合前置 Stage 的契约产物（供后续 Stage 引用）。 */
    getContractArtifacts() {
        const merged = {};
        for (const contract of this.stageContracts.values()) {
            for (const [name, files] of Object.entries(contract.contractArtifacts)) {
                merged[name] = [...(merged[name] ?? []), ...files];
            }
        }
        return merged;
    }
    /** 保存 Stage 完成契约。 */
    setStageContract(stageId, contract) {
        this.stageContracts.set(stageId, contract);
    }
    /** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
    isStageAllDone(stageId) {
        return this.stageContracts.get(stageId)?.status === 'completed';
    }
    /**
     * 推进到下一 Stage。
     *
     * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的 `next`，
     * 否则按定义数组顺序推断下一 Stage。无下一 Stage 返回 false。
     */
    tryAdvanceStage() {
        if (!this.isStageAllDone(this.currentStageId)) {
            return false;
        }
        const current = this.nodeIndex.get(this.currentStageId);
        if (current === undefined || current.kind !== 'stage') {
            return false;
        }
        let nextId = current.next;
        if (nextId === undefined) {
            const index = this.stageOrder.indexOf(current.id);
            nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
        }
        const next = nextId === undefined ? undefined : this.nodeIndex.get(nextId);
        if (next === undefined || next.kind !== 'stage') {
            return false;
        }
        this.currentStageId = next.id;
        return true;
    }
    /**
     * Step 级调度单一入口。
     *
     * 按优先级解析下一批节点：① Loop（`loop.next` > 分支评估 > `node.next`，仅同阶段，
     * 回边经 `checkLoopBreak` 判定跳出/继续）；② Branches（评估 `condition` 路由到
     * expectation 匹配分支，无 expectation 的并行分支始终纳入，无匹配回退 `node.next`）；
     * ③ Next（同阶段）；④ 无 Step 级目标返回空（由引擎 `tryAdvanceStage` 跨阶段推进）。
     */
    async resolveNextNodes(nodeId, context) {
        const node = this.nodeIndex.get(nodeId);
        if (node === undefined || node.kind !== 'step') {
            return { nextNodeIds: [] };
        }
        if (node.loop !== undefined) {
            return this.resolveLoop(node, context);
        }
        if (node.branches !== undefined && node.branches.length > 0) {
            return this.resolveBranches(node, context);
        }
        if (node.next !== undefined && this.sameStageStep(node, node.next) !== undefined) {
            return { nextNodeIds: [node.next] };
        }
        const arrayNext = this.arrayNextStep(node);
        if (arrayNext !== undefined) {
            return { nextNodeIds: [arrayNext] };
        }
        return { nextNodeIds: [] };
    }
    /** 循环路由：首次进入压栈，回边经 checkLoopBreak 判定跳出（exitTo）或继续（loopTo）。 */
    async resolveLoop(node, context) {
        const loop = node.loop;
        if (this.loopManager.activeLoopNodeId !== node.id) {
            // 首次进入（或嵌套新循环）：重置本循环节点的访问计数（嵌套循环外层下一轮重新
            // 进入内层时清零，否则内层 visitCount 停在 maxIterations 会在首次回边即提前跳出），
            // 压循环栈（迭代计数初始 1），直接进入 loopTo。
            context.visitCounts[node.id] = 0;
            this.loopManager.pushActiveLoop(node.id, loop.maxIterations);
            const loopTo = await this.resolveLoopTo(node, context);
            if (loopTo === undefined) {
                this.loopManager.popActiveLoop();
                return { nextNodeIds: this.exitLoopIds(node) };
            }
            return { nextNodeIds: [loopTo] };
        }
        // 回边：累计循环节点访问计数（回边次数），判定跳出或继续下一迭代。
        const visitCount = (context.visitCounts[node.id] ?? 0) + 1;
        context.visitCounts[node.id] = visitCount;
        const outcome = await this.loopManager.checkLoopBreak({ id: node.id, loop }, visitCount, { input: '', output: '', passThroughVars: context.passThroughVars });
        if (outcome.shouldBreak) {
            this.loopManager.popActiveLoop();
            return {
                nextNodeIds: this.exitLoopIds(node),
                ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
            };
        }
        this.loopManager.incrementLoopIteration();
        const loopTo = await this.resolveLoopTo(node, context);
        if (loopTo === undefined) {
            this.loopManager.popActiveLoop();
            return { nextNodeIds: this.exitLoopIds(node) };
        }
        return { nextNodeIds: [loopTo] };
    }
    /** 分支路由：匹配 expectation 的分支 + 并行分支（无 expectation）入下一批。 */
    async resolveBranches(node, context) {
        const branches = node.branches ?? [];
        const parallel = branches.filter(branch => branch.expectation === undefined);
        const expected = branches.filter(branch => branch.expectation !== undefined);
        const nextNodeIds = [];
        for (const branch of parallel) {
            if (this.sameStageStep(node, branch.next) !== undefined) {
                nextNodeIds.push(branch.next);
            }
        }
        if (node.condition !== undefined && expected.length > 0) {
            const result = await this.evaluator.evaluate(node.condition, '', this.branchEvalOptions(node, context));
            const expectation = extractExpectation(result.output);
            const branchMeta = {
                status: 'completed',
                result: result.output,
                ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
                expectation,
            };
            const matched = this.matchBranches(expectation, expected);
            for (const branch of matched) {
                if (this.sameStageStep(node, branch.next) !== undefined) {
                    nextNodeIds.push(branch.next);
                }
            }
            if (matched.length > 0) {
                return { nextNodeIds: dedupe(nextNodeIds), branchMeta };
            }
            // 无匹配：回退 node.next（保留原始评估现场 branchMeta）。
            this.pushFallthrough(node, nextNodeIds);
            return { nextNodeIds: dedupe(nextNodeIds), branchMeta };
        }
        // 无 condition 或无带 expectation 的分支：仅并行分支 + 回退。
        this.pushFallthrough(node, nextNodeIds);
        return { nextNodeIds: dedupe(nextNodeIds) };
    }
    /** 循环内跳转目标：`loop.next` > 分支评估 > `node.next`（均限同 Stage）。 */
    async resolveLoopTo(node, context) {
        const loop = node.loop;
        if (loop.next !== undefined && this.sameStageStep(node, loop.next) !== undefined) {
            return loop.next;
        }
        const loopBranch = await this.evaluateLoopBranch(node, context);
        if (loopBranch !== undefined) {
            return loopBranch;
        }
        if (node.next !== undefined && this.sameStageStep(node, node.next) !== undefined) {
            return node.next;
        }
        return undefined;
    }
    /** 循环节点带 condition/branches 时用分支评估结果确定 loopTo（首个匹配分支）。 */
    async evaluateLoopBranch(node, context) {
        if (node.condition === undefined || node.branches === undefined) {
            return undefined;
        }
        const result = await this.evaluator.evaluate(node.condition, '', this.branchEvalOptions(node, context));
        const expectation = extractExpectation(result.output);
        const matched = this.matchBranches(expectation, node.branches);
        for (const branch of matched) {
            if (this.sameStageStep(node, branch.next) !== undefined) {
                return branch.next;
            }
        }
        return undefined;
    }
    /** 循环跳出目标：`exitTo`（限同 Stage）否则空（由 tryAdvanceStage 推进）。 */
    exitLoopIds(node) {
        const exitTo = node.loop?.exitTo;
        if (exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined) {
            return [exitTo];
        }
        return [];
    }
    /** 无匹配时的 Step 级回退（node.next 优先，回退数组顺序下一 Step，均限同 Stage）。 */
    pushFallthrough(node, nextNodeIds) {
        if (node.next !== undefined && this.sameStageStep(node, node.next) !== undefined) {
            nextNodeIds.push(node.next);
            return;
        }
        const arrayNext = this.arrayNextStep(node);
        if (arrayNext !== undefined) {
            nextNodeIds.push(arrayNext);
        }
    }
    /** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
    arrayNextStep(node) {
        if (node.kind !== 'step') {
            return undefined;
        }
        const steps = node.stage.steps;
        const index = steps.findIndex(step => step.id === node.id);
        return index < 0 ? undefined : steps[index + 1]?.id;
    }
    /** 匹配 expectation 的带 expectation 分支。 */
    matchBranches(expectation, branches) {
        const matched = [];
        for (const branch of branches) {
            if (branch.expectation !== undefined && matchesExpectation(expectation, branch.expectation)) {
                matched.push(branch);
            }
        }
        return matched;
    }
    /** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + 取消信号）。 */
    branchEvalOptions(node, context) {
        const loopContext = this.loopManager.getLoopIterationContext();
        return {
            ...(node.branches === undefined ? {} : { branches: node.branches }),
            passThroughVars: context.passThroughVars,
            loopTurn: loopContext.loopTurn,
            loopMaxIterations: loopContext.loopMaxIterations,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
        };
    }
    /** 目标节点是否为同 Stage 内的 Step（跨阶段隔离：跨 Stage 目标返回 undefined）。 */
    sameStageStep(node, targetId) {
        const target = this.nodeIndex.get(targetId);
        if (target === undefined || target.kind !== 'step') {
            return undefined;
        }
        if (target.stage.id !== node.stage.id) {
            return undefined;
        }
        return target;
    }
    buildNodeIndex(definition) {
        for (const stage of definition.stages) {
            this.nodeIndex.set(stage.id, {
                kind: 'stage',
                stage,
                id: stage.id,
                name: stage.name,
                next: stage.next,
                condition: stage.condition,
                branches: stage.branches,
                loop: stage.loop,
            });
            for (const step of stage.steps) {
                this.nodeIndex.set(step.id, {
                    kind: 'step',
                    stage,
                    step,
                    id: step.id,
                    name: step.name ?? step.id,
                    next: step.next,
                    condition: step.condition,
                    branches: step.branches,
                    loop: step.loop,
                });
            }
        }
    }
}
//# sourceMappingURL=dag-navigator.js.map