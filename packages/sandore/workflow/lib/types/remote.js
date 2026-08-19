var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SandoreError } from "./errors.js";
import { parseWorkflowYaml, serializeWorkflowYaml } from "./yaml-parser.js";
import { CreateDefinitionInputSchema, PauseAllInputSchema, PauseStepInputSchema, ReplyPermissionInputSchema, ReplyQuestionInputSchema, ResumeAllInputSchema, ResumeStepInputSchema, RetryStepInputSchema, StartInstanceInputSchema, UpdateDefinitionInputSchema, } from "./wire.js";
/** 实例的终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
/**
 * sandore 的 Host RPC 服务。
 *
 * 定义/Job/实例 CRUD + 7 个生命周期 RPC + 产物查询 + Provider/Model 转发；
 * `ping` 保留。
 */
let SandoreRemote = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _ping_decorators;
    let _listDefinitions_decorators;
    let _createDefinition_decorators;
    let _updateDefinition_decorators;
    let _deleteDefinition_decorators;
    let _getYaml_decorators;
    let _updateYaml_decorators;
    let _listInstances_decorators;
    let _startInstance_decorators;
    let _deleteInstance_decorators;
    let _getInstanceState_decorators;
    let _abortInstance_decorators;
    let _replyQuestion_decorators;
    let _replyPermission_decorators;
    let _pauseStep_decorators;
    let _resumeStep_decorators;
    let _pauseAll_decorators;
    let _resumeAll_decorators;
    let _retryStep_decorators;
    let _getArtifacts_decorators;
    let _listProviders_decorators;
    let _listModels_decorators;
    return class SandoreRemote extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _ping_decorators = [Remote('ping')];
            _listDefinitions_decorators = [Remote('listDefinitions')];
            _createDefinition_decorators = [Remote('createDefinition')];
            _updateDefinition_decorators = [Remote('updateDefinition')];
            _deleteDefinition_decorators = [Remote('deleteDefinition')];
            _getYaml_decorators = [Remote('getYaml')];
            _updateYaml_decorators = [Remote('updateYaml')];
            _listInstances_decorators = [Remote('listInstances')];
            _startInstance_decorators = [Remote('startInstance')];
            _deleteInstance_decorators = [Remote('deleteInstance')];
            _getInstanceState_decorators = [Remote('getInstanceState')];
            _abortInstance_decorators = [Remote('abortInstance')];
            _replyQuestion_decorators = [Remote('replyQuestion')];
            _replyPermission_decorators = [Remote('replyPermission')];
            _pauseStep_decorators = [Remote('pauseStep')];
            _resumeStep_decorators = [Remote('resumeStep')];
            _pauseAll_decorators = [Remote('pauseAll')];
            _resumeAll_decorators = [Remote('resumeAll')];
            _retryStep_decorators = [Remote('retryStep')];
            _getArtifacts_decorators = [Remote('getArtifacts')];
            _listProviders_decorators = [Remote('listProviders')];
            _listModels_decorators = [Remote('listModels')];
            __esDecorate(this, null, _ping_decorators, { kind: "method", name: "ping", static: false, private: false, access: { has: obj => "ping" in obj, get: obj => obj.ping }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listDefinitions_decorators, { kind: "method", name: "listDefinitions", static: false, private: false, access: { has: obj => "listDefinitions" in obj, get: obj => obj.listDefinitions }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createDefinition_decorators, { kind: "method", name: "createDefinition", static: false, private: false, access: { has: obj => "createDefinition" in obj, get: obj => obj.createDefinition }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _updateDefinition_decorators, { kind: "method", name: "updateDefinition", static: false, private: false, access: { has: obj => "updateDefinition" in obj, get: obj => obj.updateDefinition }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteDefinition_decorators, { kind: "method", name: "deleteDefinition", static: false, private: false, access: { has: obj => "deleteDefinition" in obj, get: obj => obj.deleteDefinition }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getYaml_decorators, { kind: "method", name: "getYaml", static: false, private: false, access: { has: obj => "getYaml" in obj, get: obj => obj.getYaml }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _updateYaml_decorators, { kind: "method", name: "updateYaml", static: false, private: false, access: { has: obj => "updateYaml" in obj, get: obj => obj.updateYaml }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listInstances_decorators, { kind: "method", name: "listInstances", static: false, private: false, access: { has: obj => "listInstances" in obj, get: obj => obj.listInstances }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _startInstance_decorators, { kind: "method", name: "startInstance", static: false, private: false, access: { has: obj => "startInstance" in obj, get: obj => obj.startInstance }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteInstance_decorators, { kind: "method", name: "deleteInstance", static: false, private: false, access: { has: obj => "deleteInstance" in obj, get: obj => obj.deleteInstance }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getInstanceState_decorators, { kind: "method", name: "getInstanceState", static: false, private: false, access: { has: obj => "getInstanceState" in obj, get: obj => obj.getInstanceState }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _abortInstance_decorators, { kind: "method", name: "abortInstance", static: false, private: false, access: { has: obj => "abortInstance" in obj, get: obj => obj.abortInstance }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _replyQuestion_decorators, { kind: "method", name: "replyQuestion", static: false, private: false, access: { has: obj => "replyQuestion" in obj, get: obj => obj.replyQuestion }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _replyPermission_decorators, { kind: "method", name: "replyPermission", static: false, private: false, access: { has: obj => "replyPermission" in obj, get: obj => obj.replyPermission }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pauseStep_decorators, { kind: "method", name: "pauseStep", static: false, private: false, access: { has: obj => "pauseStep" in obj, get: obj => obj.pauseStep }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resumeStep_decorators, { kind: "method", name: "resumeStep", static: false, private: false, access: { has: obj => "resumeStep" in obj, get: obj => obj.resumeStep }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pauseAll_decorators, { kind: "method", name: "pauseAll", static: false, private: false, access: { has: obj => "pauseAll" in obj, get: obj => obj.pauseAll }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resumeAll_decorators, { kind: "method", name: "resumeAll", static: false, private: false, access: { has: obj => "resumeAll" in obj, get: obj => obj.resumeAll }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _retryStep_decorators, { kind: "method", name: "retryStep", static: false, private: false, access: { has: obj => "retryStep" in obj, get: obj => obj.retryStep }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getArtifacts_decorators, { kind: "method", name: "getArtifacts", static: false, private: false, access: { has: obj => "getArtifacts" in obj, get: obj => obj.getArtifacts }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listProviders_decorators, { kind: "method", name: "listProviders", static: false, private: false, access: { has: obj => "listProviders" in obj, get: obj => obj.listProviders }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listModels_decorators, { kind: "method", name: "listModels", static: false, private: false, access: { has: obj => "listModels" in obj, get: obj => obj.listModels }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['sandorePersistence', 'sandoreEngine', 'llm'];
        constructor(ctx) {
            super(ctx, 'sandore');
            __runInitializers(this, _instanceExtraInitializers);
        }
        /** 健康检查往返，验证 Host/Client RPC 链路。 */
        ping() {
            return { pong: true, service: 'sandore', time: new Date().toISOString() };
        }
        // ── 定义 CRUD ────────────────────────────────────────────────────────────
        /** 列出全部工作流定义（含 `id` 键）。 */
        listDefinitions() {
            const entries = [];
            for (const [id, record] of this.ctx.sandorePersistence.definitions.entries()) {
                entries.push({ id, ...record });
            }
            return entries;
        }
        /**
         * 创建定义：解析+验证 YAML → 生成 `wfl-{uuid}` → 以规范 id 重新序列化存储。
         * 非法 YAML 抛 `SandoreError`，`definitions` 表不新增记录。存储的 YAML 文本顶层
         * `id` 与记录键一致（客户端传入的哨兵 id 如 `wfl-new` 不回写进持久化文本）。
         */
        async createDefinition(input) {
            const parsed = CreateDefinitionInputSchema.parse(input);
            const definition = parseWorkflowYaml(parsed.yaml);
            const id = `wfl-${globalThis.crypto.randomUUID()}`;
            const now = new Date().toISOString();
            const record = {
                yaml: serializeWorkflowYaml({ ...definition, id }),
                name: definition.name,
                version: definition.version,
                ...(definition.description === undefined ? {} : { description: definition.description }),
                createdAt: now,
                updatedAt: now,
            };
            await this.ctx.sandorePersistence.definitions.put(id, record);
            return { id, ...record };
        }
        /** 更新定义元数据（name/version/description），保留 yaml 文本。 */
        async updateDefinition(id, input) {
            const parsed = UpdateDefinitionInputSchema.parse(input);
            const existing = this.requireDefinition(id);
            const now = new Date().toISOString();
            const description = parsed.description ?? existing.description;
            const next = {
                yaml: existing.yaml,
                name: parsed.name ?? existing.name,
                version: parsed.version ?? existing.version,
                ...(description === undefined ? {} : { description }),
                createdAt: existing.createdAt,
                updatedAt: now,
            };
            await this.ctx.sandorePersistence.definitions.put(id, next);
            return { id, ...next };
        }
        /** 删除定义（不级联删除实例）；重复删除幂等（返回 false）。 */
        async deleteDefinition(id) {
            return await this.ctx.sandorePersistence.definitions.delete(id);
        }
        /** 读取定义的原始 YAML 文本。 */
        getYaml(id) {
            return this.requireDefinition(id).yaml;
        }
        /** 重新验证后覆盖定义的 YAML 文本；非法 YAML 抛错且存储保持旧值。
         *  元数据（name/version/description）从新 YAML 解析同步，保证列表展示与内容一致。 */
        async updateYaml(id, yaml) {
            const parsed = parseWorkflowYaml(yaml);
            const existing = this.requireDefinition(id);
            const now = new Date().toISOString();
            const next = {
                yaml,
                name: parsed.name,
                version: parsed.version,
                ...(parsed.description === undefined ? {} : { description: parsed.description }),
                createdAt: existing.createdAt,
                updatedAt: now,
            };
            await this.ctx.sandorePersistence.definitions.put(id, next);
            return { id, ...next };
        }
        // ── 实例生命周期 ─────────────────────────────────────────────────────────
        /** 列出实例摘要（从 `state` 表派生，去 job 概念）。 */
        listInstances() {
            const summaries = [];
            for (const [instanceId, state] of this.ctx.sandorePersistence.state.entries()) {
                summaries.push({
                    instanceId,
                    workflowId: state.workflowId,
                    originalInput: state.originalInput,
                    status: state.status,
                    createdAt: state.createdAt,
                    updatedAt: state.updatedAt,
                });
            }
            return summaries;
        }
        /** 启动实例：校验定义存在后转发 `ctx.sandoreEngine.startInstance`（去 job 概念）。 */
        async startInstance(input) {
            const parsed = StartInstanceInputSchema.parse(input);
            if (this.ctx.sandorePersistence.definitions.get(parsed.workflowId) === undefined) {
                throw new SandoreError(`workflow '${parsed.workflowId}' does not exist`, 'INVALID_OPERATION');
            }
            const request = {
                workflowId: parsed.workflowId,
                originalInput: parsed.originalInput,
                ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
                ...(parsed.model === undefined ? {} : { model: parsed.model }),
                ...(parsed.permission === undefined ? {} : { permission: parsed.permission }),
            };
            return await this.ctx.sandoreEngine.startInstance(request);
        }
        /** 删除实例快照（`state` 表删除）；重复删除幂等。 */
        async deleteInstance(instanceId) {
            return await this.ctx.sandorePersistence.state.delete(instanceId);
        }
        /** 读取实例的完整状态快照；不存在抛 `NODE_NOT_FOUND`。 */
        getInstanceState(instanceId) {
            return this.requireInstanceState(instanceId);
        }
        /** 中止运行中实例（转发引擎）；终态实例抛 `INVALID_OPERATION`。 */
        async abortInstance(instanceId) {
            const state = this.requireInstanceState(instanceId);
            if (TERMINAL_STATUSES.has(state.status)) {
                throw new SandoreError(`instance '${instanceId}' is already in terminal state '${state.status}'`, 'INVALID_OPERATION');
            }
            await this.ctx.sandoreEngine.abortInstance(instanceId);
        }
        // ── 生命周期 RPC ────────────────────────────────────────────────────────
        /** 回复待处理问答（转发 `ctx.sandoreEngine.replyQuestion`）。 */
        async replyQuestion(input) {
            const parsed = ReplyQuestionInputSchema.parse(input);
            // zod 已对 answers 结构做显式运行时校验；此处桥接 `exactOptionalPropertyTypes`
            // 下 `custom?: string` 与 zod `.optional()` 推断 `string | undefined` 的类型差异。
            await this.ctx.sandoreEngine.replyQuestion(parsed.instanceId, parsed.requestId, parsed.answers);
        }
        /** 回复待处理权限请求（转发 `ctx.sandoreEngine.replyPermission`）。 */
        async replyPermission(input) {
            const parsed = ReplyPermissionInputSchema.parse(input);
            await this.ctx.sandoreEngine.replyPermission(parsed.instanceId, parsed.requestId, parsed.reply);
        }
        /** 暂停单个 Step（转发 `ctx.sandoreEngine.pauseStep`）。 */
        async pauseStep(input) {
            const parsed = PauseStepInputSchema.parse(input);
            await this.ctx.sandoreEngine.pauseStep(parsed.instanceId, parsed.stepId);
        }
        /** 恢复单个 Step（转发 `ctx.sandoreEngine.resumeStep`，可选恢复提示词）。 */
        async resumeStep(input) {
            const parsed = ResumeStepInputSchema.parse(input);
            await this.ctx.sandoreEngine.resumeStep(parsed.instanceId, parsed.stepId, parsed.resumePrompt);
        }
        /** 暂停实例内全部 Step（转发 `ctx.sandoreEngine.pauseAllSteps`）。 */
        async pauseAll(input) {
            const parsed = PauseAllInputSchema.parse(input);
            await this.ctx.sandoreEngine.pauseAllSteps(parsed.instanceId);
        }
        /** 恢复实例内全部 Step（转发 `ctx.sandoreEngine.resumeAllSteps`，可选恢复提示词）。 */
        async resumeAll(input) {
            const parsed = ResumeAllInputSchema.parse(input);
            await this.ctx.sandoreEngine.resumeAllSteps(parsed.instanceId, parsed.resumePrompt);
        }
        /** 重试失败 Step（转发 `ctx.sandoreEngine.retryStep`）。 */
        async retryStep(input) {
            const parsed = RetryStepInputSchema.parse(input);
            await this.ctx.sandoreEngine.retryStep(parsed.instanceId, parsed.stepId, parsed.mode, parsed.message);
        }
        // ── 产物 / Provider 转发 ─────────────────────────────────────────────────
        /**
         * 查询实例产物：从 `stageContracts` 的产物契约扁平化条目，可选按 stageId 过滤。
         */
        getArtifacts(instanceId, stageId) {
            const state = this.requireInstanceState(instanceId);
            const entries = [];
            for (const [contractStageId, contract] of Object.entries(state.stageContracts)) {
                if (stageId !== undefined && contractStageId !== stageId)
                    continue;
                for (const artifact of contract.artifacts) {
                    entries.push({
                        stepId: artifact.stepId,
                        stageId: contractStageId,
                        outputToId: artifact.outputToId,
                        files: [...artifact.files],
                        ...(artifact.returnPrompt === undefined ? {} : { returnPrompt: artifact.returnPrompt }),
                    });
                }
            }
            return entries;
        }
        /** 列出 LLM Provider（透传 `ctx.llm.listProviders()`）。 */
        listProviders() {
            return this.ctx.llm.listProviders();
        }
        /** 列出某 Provider 的模型（透传 `ctx.llm.listModels()`）。 */
        async listModels(provider) {
            return await this.ctx.llm.listModels(provider);
        }
        // ── 私有守卫 ─────────────────────────────────────────────────────────────
        requireDefinition(id) {
            const record = this.ctx.sandorePersistence.definitions.get(id);
            if (record === undefined) {
                throw new SandoreError(`definition '${id}' not found`, 'NODE_NOT_FOUND');
            }
            return { id, ...record };
        }
        requireInstanceState(instanceId) {
            const state = this.ctx.sandorePersistence.state.get(instanceId);
            if (state === undefined) {
                throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
            }
            return state;
        }
    };
})();
export { SandoreRemote };
export default SandoreRemote;
//# sourceMappingURL=remote.js.map