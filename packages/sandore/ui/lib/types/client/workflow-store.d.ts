/**
 * 工作流 UI 的模块级状态（overlay 开关 / 左列表模式 / 编辑区模式 / 选中项 / 面板宽度）。
 *
 * 自实现 getSnapshot/subscribe（DSH bundle 的 ModuleLoader 格式无法被 bundler
 * 静态分析出 `createSnapshotStore` 具名导出，故不依赖 dsh-client-runtime）。
 * 状态跨 overlay 开合与会话切换保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-store
 */
/** 编辑区模式：编排（DagEditor 画布）| 执行（RunView 三栏）。 */
export type EditorMode = 'dag' | 'run';
/** 左列表模式：实例列表 | 定义列表（编排）。 */
export type ListMode = 'instance' | 'definition';
/** 右栏预览目标（树形导航叶子点击后出现）。 */
export interface PreviewTarget {
    /** 叶子节点 id（供树形导航高亮匹配）。 */
    readonly leafId?: string | undefined;
    readonly kind: 'result' | 'artifact';
    /** 归属 Step id。 */
    readonly stepId: string;
    /** 展示名称。 */
    readonly name: string;
    /** 元信息（如文件路径 / 大小占位）。 */
    readonly meta?: string | undefined;
    /** 预览正文（returnPrompt 或文件路径集合）。 */
    readonly text?: string | undefined;
}
/** 工作流 UI 的全局状态快照。 */
export interface WorkflowUiState {
    /** overlay 是否打开。 */
    readonly open: boolean;
    /** 编辑区模式（编排/执行）。 */
    readonly mode: EditorMode;
    /** 左列表模式（实例/定义）。 */
    readonly listMode: ListMode;
    /** 当前选中实例（执行态）。 */
    readonly selectedInstanceId: string | undefined;
    /** 当前选中定义（编排态）。 */
    readonly selectedDefinition: {
        readonly id?: string | undefined;
        readonly initialYaml?: string | undefined;
    } | undefined;
    /** 是否处于「新建定义」态（未选中任何定义但右侧显示空白 DagEditor）。 */
    readonly creatingNew: boolean;
    /** 右栏预览目标（null = 关闭）。 */
    readonly preview: PreviewTarget | null;
    /** 左列表列宽（px）。 */
    readonly listWidth: number;
    /** RunView 树形导航列宽（px）。 */
    readonly treeWidth: number;
    /** RunView 预览列宽（px）。 */
    readonly previewWidth: number;
}
/** 当前状态快照（稳定引用，仅 set 时更换）。 */
export declare function getWorkflowState(): WorkflowUiState;
/** 订阅状态变更。 */
export declare function subscribeWorkflowState(listener: () => void): () => void;
/** 合并补丁更新状态并通知订阅者。 */
export declare function setWorkflowState(patch: Partial<WorkflowUiState>): void;
/** 打开 overlay。 */
export declare function openWorkflowOverlay(): void;
/** 切换 overlay 开关（侧边栏入口按钮：打开状态再点一次关闭）。 */
export declare function toggleWorkflowOverlay(): void;
/** 关闭 overlay（保留选中态，便于再次打开）。 */
export declare function closeWorkflowOverlay(): void;
/** 选中实例：切执行态 + 清定义选中 + 关预览。 */
export declare function selectInstance(instanceId: string): void;
/** 选中定义：直接进入编排态（DAG 画布 + 右侧默认工作流详情）+ 清实例选中 + 关预览。 */
export declare function selectDefinition(id: string, initialYaml: string): void;
/** 新建定义：切编排态，直接进入空白 DagEditor。 */
export declare function newDefinition(): void;
/** 更新列表列宽（拖拽分隔条，带边界钳制）。 */
export declare function resizeListWidth(delta: number): void;
/** 更新树形导航列宽（拖拽分隔条，带边界钳制）。 */
export declare function resizeTreeWidth(delta: number): void;
/** 更新预览列宽（拖拽分隔条，带边界钳制）。 */
export declare function resizePreviewWidth(delta: number): void;
//# sourceMappingURL=workflow-store.d.ts.map