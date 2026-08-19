/**
 * composer 选择器的运行时注入面（模型目录 / 会话权限投影 / 命令执行）。
 *
 * 编译期不依赖 DSH 的 ui-model-selection / ui-permission-presets 包（沙盒仓库
 * 未链接它们），这里按 harness 的 wire 形状自声明最小类型；运行时复用 dev 实例
 * 已加载的 `ctx.modelDirectories` 服务、会话 projections 与 `remote.commands`，
 * 行为与 DSH 主 session 的模型/权限选择完全一致（同一数据源、同一 RPC）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/model-faces
 */
/** 可订阅快照面（对齐 runtime 的 `ObservableSnapshot`）。 */
export interface ObservableFace<T> {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
}
/** 一个会话的完整模型选择。 */
export interface ModelSelection {
    /** 注册的 provider 路由。 */
    provider: string;
    /** provider 属下的模型 id。 */
    model: string;
    /** 推理等级（缺省保留 provider/adapter 默认）。 */
    reasoningEffort?: string;
}
/** adapter 属下的一个推理等级。 */
export interface ModelReasoningEffort {
    id: string;
    name: string;
    description?: string;
}
/** 单个精确模型路由的可选推理元数据。 */
export interface ModelReasoning {
    efforts: ModelReasoningEffort[];
    defaultEffort?: string;
}
/** provider 组内展示的一个模型。 */
export interface ModelCatalogModel {
    id: string;
    name: string;
    description?: string;
    reasoning?: ModelReasoning;
}
/** 一个成功广告了模型的 provider 组。 */
export interface ModelProviderGroup {
    id: string;
    name: string;
    models: ModelCatalogModel[];
}
/** 目录加载失败的 provider。 */
export interface ModelCatalogFailure {
    id: string;
    name: string;
    message: string;
}
/** 模型目录快照（对齐 ui-model-selection 的 `ModelDirectoryState`）。 */
export interface ModelDirectoryState {
    current: ModelSelection | null;
    routable: boolean | null;
    groups: readonly ModelProviderGroup[];
    failures: readonly ModelCatalogFailure[];
    status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
    error: string | null;
}
/** 单个会话的共享模型目录控制面（对齐 `ModelDirectory`）。 */
export interface ModelDirectoryFace {
    readonly store: ObservableFace<ModelDirectoryState>;
    load(): Promise<unknown>;
    select(selection: ModelSelection): Promise<void>;
    dispose(): void;
}
/** `connection.api.sessions` 的最小模型 RPC 面（对齐 harness apiproxy sessions.ts）。 */
export interface SessionModelsWire {
    current: ModelSelection;
    routable: boolean;
    groups: ModelProviderGroup[];
    failures: ModelCatalogFailure[];
}
/** `connection.api.sessions.models/selectModel` 的最小面。 */
export interface SessionModelsApi {
    models(input: {
        sessionId: string;
    }): Promise<{
        result: {
            ok: boolean;
            value: SessionModelsWire;
            error?: {
                code: string;
                message: string;
            };
        };
    }>;
    selectModel(input: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<{
        result: {
            ok: boolean;
            value: {
                selected: ModelSelection;
            };
            error?: {
                code: string;
                message: string;
            };
        };
    }>;
}
/**
 * 轻量每会话模型目录（对齐 DSH ui-model-selection 的 `ModelDirectory`）：
 * 直接走 `connection.api.sessions.models/selectModel`（同一 RPC、同一行为），
 * 不依赖 DSH 会话 scope（sandore 实例会话未必被 DSH 会话列表 staged）。
 */
export declare class SandoreModelDirectory implements ModelDirectoryFace {
    private readonly api;
    private readonly sessionId;
    readonly store: ObservableFace<ModelDirectoryState>;
    private state;
    private readonly listeners;
    private generation;
    private disposed;
    constructor(api: SessionModelsApi, sessionId: string);
    /** 刷新目录（失败保留上次好数据；打开菜单时调用，行为同 DSH）。 */
    load(): Promise<unknown>;
    /** 选择完整 provider/model/推理等级（提交 `selectModel` 绑定会话）。 */
    select(selection: ModelSelection): Promise<void>;
    /** 会话 scope 拆除时调用（沙盒目录随组件卸载回收）。 */
    dispose(): void;
    private update;
}
/** 权限模式选项。 */
export interface PermissionOption {
    value: string;
    name: string;
    description?: string;
}
/** 权限选择投影值（`projections.permissions`）。 */
export interface PermissionSelectValue {
    options: PermissionOption[];
    currentValue: string;
}
/** `remote.commands.execute` 的最小返回面。 */
export interface CommandExecuteResult {
    ok: boolean;
    value?: unknown;
    error?: {
        code: string;
        message: string;
    };
}
/**
 * 解析 `/permission`（无参）命令报告文本：
 * `current preset workspace-write (available: workspace-write, danger-full-access)`。
 * 权限投影缺失时作为回退数据源（与 DSH 主 session 的权限选择同一命令路径）。
 */
export declare function parsePermissionReport(text: string): PermissionSelectValue | undefined;
//# sourceMappingURL=model-faces.d.ts.map