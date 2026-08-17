/**
 * WorkflowPanel 两级下钻的 view 状态栈 reducer（无 React 依赖，可单测）。
 *
 * 面板内部维护一个 view 栈：栈底恒为 `list`（默认/编排列表态），点击实例压入
 * `run`（RunView），点击定义压入 `editor`（DagEditor），返回按钮 `back` 弹出
 * 栈顶回退列表态。`list` 视图上的编排 toggle/搜索状态由 WorkflowPanel 自身持有，
 * 不进栈，故下钻返回后自然保留。栈以普通不可变数组表示，`open` 追加、`back`
 * 弹出且永不低于栈底，reducer 为纯函数（不修改入参、无副作用）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/view-stack
 */
/** view 栈初始态：仅列表态在栈底。 */
export const INITIAL_VIEW_STACK = [{ kind: 'list' }];
/**
 * view 栈 reducer：`open` 追加视图到栈顶，`back` 弹出栈顶（栈底 `list` 不回退）。
 * @param state - 当前 view 栈（不可变数组）。
 * @param action - 压入或回退动作。
 * @returns 新的 view 栈。
 */
export function viewStackReducer(state, action) {
    switch (action.type) {
        case 'open':
            return [...state, action.view];
        case 'back':
            return state.length <= 1 ? state : state.slice(0, -1);
        default:
            // 未知动作不改变状态（防御，穷尽联合下不可达）。
            return state;
    }
}
/**
 * 取栈顶视图：栈恒非空（`INITIAL_VIEW_STACK` 起底、`back` 不回退栈底），
 * 兜底返回 list 以消除 `noUncheckedIndexedAccess` 下的 undefined 分支。
 * @param stack - 当前 view 栈。
 * @returns 栈顶视图。
 */
export function topView(stack) {
    return stack[stack.length - 1] ?? { kind: 'list' };
}
//# sourceMappingURL=view-stack.js.map