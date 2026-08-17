/**
 * 工作流 UI 的模块级状态（overlay 开关 / 左列表模式 / 编辑区模式 / 选中项 / 面板宽度）。
 *
 * 自实现 getSnapshot/subscribe（DSH bundle 的 ModuleLoader 格式无法被 bundler
 * 静态分析出 `createSnapshotStore` 具名导出，故不依赖 dsh-client-runtime）。
 * 状态跨 overlay 开合与会话切换保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/workflow-store
 */
const INITIAL = {
    open: false,
    mode: 'dag',
    listMode: 'instance',
    selectedInstanceId: undefined,
    selectedDefinition: undefined,
    creatingNew: false,
    preview: null,
    listWidth: 300,
    treeWidth: 240,
    previewWidth: 380,
};
let state = INITIAL;
const listeners = new Set();
/** 当前状态快照（稳定引用，仅 set 时更换）。 */
export function getWorkflowState() {
    return state;
}
/** 订阅状态变更。 */
export function subscribeWorkflowState(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
/** 合并补丁更新状态并通知订阅者。 */
export function setWorkflowState(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners)
        listener();
}
/** 打开 overlay。 */
export function openWorkflowOverlay() {
    setWorkflowState({ open: true });
}
/** 切换 overlay 开关（侧边栏入口按钮：打开状态再点一次关闭）。 */
export function toggleWorkflowOverlay() {
    setWorkflowState({ open: !state.open });
}
/** 关闭 overlay（保留选中态，便于再次打开）。 */
export function closeWorkflowOverlay() {
    setWorkflowState({ open: false });
}
/** 选中实例：切执行态 + 清定义选中 + 关预览。 */
export function selectInstance(instanceId) {
    setWorkflowState({
        mode: 'run',
        selectedInstanceId: instanceId,
        selectedDefinition: undefined,
        creatingNew: false,
        preview: null,
    });
}
/** 选中定义：直接进入编排态（DAG 画布 + 右侧默认工作流详情）+ 清实例选中 + 关预览。 */
export function selectDefinition(id, initialYaml) {
    setWorkflowState({
        mode: 'dag',
        selectedDefinition: { id, initialYaml },
        creatingNew: false,
        selectedInstanceId: undefined,
        preview: null,
    });
}
/** 新建定义：切编排态，直接进入空白 DagEditor。 */
export function newDefinition() {
    setWorkflowState({
        mode: 'dag',
        selectedDefinition: undefined,
        creatingNew: true,
        selectedInstanceId: undefined,
        preview: null,
    });
}
/** 更新列表列宽（拖拽分隔条，带边界钳制）。 */
export function resizeListWidth(delta) {
    setWorkflowState({ listWidth: clamp(state.listWidth + delta, 200, 520) });
}
/** 更新树形导航列宽（拖拽分隔条，带边界钳制）。 */
export function resizeTreeWidth(delta) {
    setWorkflowState({ treeWidth: clamp(state.treeWidth + delta, 180, 420) });
}
/** 更新预览列宽（拖拽分隔条，带边界钳制）。 */
export function resizePreviewWidth(delta) {
    setWorkflowState({ previewWidth: clamp(state.previewWidth + delta, 280, 640) });
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
//# sourceMappingURL=workflow-store.js.map