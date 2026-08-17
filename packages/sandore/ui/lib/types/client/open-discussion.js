/**
 * 构造「打开讨论」回调：调用时经 `sessions.open(instanceId)` 跳宿主会话。
 * @param sessions - `ctx.sessions` 的最小打开面。
 * @param instanceId - 目标工作流实例 id（宿主 Session id == instanceId）。
 * @returns 供 RunView `openDiscussion` prop 直接使用的回调。
 */
export function createOpenDiscussion(sessions, instanceId) {
    return () => {
        // 宿主 Session id == instanceId；brand 仅编译期标记，运行时就是同一字符串。
        sessions.open(instanceId);
    };
}
//# sourceMappingURL=open-discussion.js.map