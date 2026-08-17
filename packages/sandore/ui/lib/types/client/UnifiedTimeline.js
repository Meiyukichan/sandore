import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * UnifiedTimeline：执行态中栏统一时间线（step 卡片 + user 气泡交错）。
 *
 * 数据由 `buildTimeline` 从实例状态派生（轮询驱动，无实时消息流）。Step 卡片按
 * 状态展示：completed → 输出文本（MessageText）+「查看详情」跳子会话；running →
 * 运行中占位；failed → 错误详情；paused → 暂停提示。滑动窗口：初始可见 N 条，
 * 滚动到顶部加载更多。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { useMemo, useRef, useState } from 'react';
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './timeline.module.css';
/** 初始可见消息数 / 每次滚动加载的增量。 */
const VISIBLE_COUNT = 50;
const VISIBLE_STEP = 50;
/** Step 执行状态 → 本地化标签键（7 态）。 */
const STEP_STATUS_KEYS = {
    blocked: 'run.step.status.blocked',
    ready: 'run.step.status.ready',
    interacting: 'run.step.status.interacting',
    running: 'run.step.status.running',
    completed: 'run.step.status.completed',
    failed: 'run.step.status.failed',
    paused: 'run.step.status.paused',
};
/** Step 卡片头像字符与语义类。 */
function stepAvatar(status) {
    switch (status) {
        case 'completed':
            return { glyph: '✓', className: css.avatarDone ?? '' };
        case 'running':
        case 'interacting':
            return { glyph: '●', className: css.avatarRun ?? '' };
        case 'failed':
            return { glyph: '✕', className: css.avatarFail ?? '' };
        case 'paused':
            return { glyph: '⏸', className: css.avatarPaused ?? '' };
        default:
            return { glyph: '○', className: css.avatarTodo ?? '' };
    }
}
/** 单个 Step 卡片。 */
function StepCard({ item, t, openSession }) {
    const avatar = stepAvatar(item.status);
    const running = item.status === 'running' || item.status === 'interacting';
    return (_jsxs("article", { className: css.stepCard, "data-tl-step": true, children: [_jsxs("header", { className: css.stepHeader, children: [_jsx("span", { className: `${css.avatar} ${avatar.className}`, "aria-hidden": true, children: avatar.glyph }), _jsxs("span", { className: css.stepName, children: [item.name, item.loopLabel !== undefined && _jsx("span", { className: css.loopLabel, children: item.loopLabel })] }), _jsxs("span", { className: `${css.badge ?? ''} ${running ? (css.badgeRun ?? '') : item.status === 'completed' ? (css.badgeDone ?? '') : item.status === 'failed' ? (css.badgeFail ?? '') : item.status === 'paused' ? (css.badgePaused ?? '') : ''}`, children: [_jsx("span", { className: css.badgeDot ?? '', "aria-hidden": true }), t(STEP_STATUS_KEYS[item.status])] }), item.visitCount > 1 && (_jsx("span", { className: css.visitCount, children: t('run.visitCount', { count: item.visitCount }) }))] }), _jsxs("div", { className: css.stepBody, children: [item.status === 'completed' && item.outputText !== undefined && (_jsx("div", { className: css.stepReturn, children: _jsx(MessageText, { text: item.outputText }) })), item.status === 'failed' && item.error !== undefined && (_jsx("div", { className: css.stepError, role: "alert", children: item.error })), item.status === 'paused' && (_jsx("div", { className: css.stepPaused, children: t('step.paused.hint') })), running && (_jsxs("div", { className: css.stepRunning, children: [t('run.step.status.running'), "\u2026"] })), item.childId !== undefined && (_jsxs("button", { type: "button", className: css.expandBtn, onClick: () => { openSession(item.childId); }, children: ["\u25B6 ", t('run.discuss')] }))] })] }));
}
/** 用户气泡。 */
function UserBubble({ content }) {
    return (_jsxs("div", { className: css.userBubble, "data-tl-user": true, children: [_jsx("div", { className: css.userContent, children: content }), _jsx("div", { className: css.userAvatar, children: "\u4F60" })] }));
}
/** 渲染统一时间线。 */
export function UnifiedTimeline({ t, items, openSession }) {
    const [visibleCount, setVisibleCount] = useState(VISIBLE_COUNT);
    const scrollRef = useRef(null);
    const visibleItems = useMemo(() => items.slice(-visibleCount), [items, visibleCount]);
    // 滑动窗口：滚动到顶部时加载更早条目。
    const handleScroll = (event) => {
        if (event.currentTarget.scrollTop === 0 && visibleCount < items.length) {
            setVisibleCount(count => Math.min(count + VISIBLE_STEP, items.length));
        }
    };
    return (_jsx("div", { className: css.scroll, ref: scrollRef, onScroll: handleScroll, "data-sandore-timeline": true, children: _jsxs("div", { className: css.timeline, children: [visibleItems.length === 0 && (_jsx("p", { className: css.empty, children: t('run.trajectory.empty') })), visibleItems.map((item, index) => (item.kind === 'user'
                    ? _jsx(UserBubble, { content: item.content }, `user-${index}`)
                    : _jsx(StepCard, { item: item, t: t, openSession: openSession }, `${item.stepId}-${index}`)))] }) }));
}
//# sourceMappingURL=UnifiedTimeline.js.map