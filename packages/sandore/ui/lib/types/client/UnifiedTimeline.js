import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * UnifiedTimeline：执行详情对话流（按 execution-detail-prototype.html 原型）。
 *
 * multica Issue 评论流 × DSH 多 agent 对话流：用户输入 = 右侧气泡；每个
 * executedStep = 一条 agent 消息（左对齐，头像 + 可点击标题 → openSession 打开
 * DSH 现成子代理会话页 + 相对时间 + 状态图标）。正文按状态呈现：
 * completed → md 渲染块（MessageText，原型 .md 样式）；running/interacting →
 * 内嵌可滚动消息框（sessionMessages 行）；failed/paused → 最近 5 条消息列表
 * （末条按失败/暂停色）。旧实例无时间戳时头部省略时间。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { IconSparkle16, MessageText } from '@deepseek-ai/dsh-client-ui-primitives';
import { relativeTimeOf, } from "./run-view-model.js";
import css from './timeline.module.css';
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
/** 状态 → 展示色类（原型 .st 的 4 色）。 */
function statusClass(status) {
    switch (status) {
        case 'completed':
            return css.stSuccess ?? '';
        case 'failed':
            return css.stDestructive ?? '';
        case 'paused':
            return css.stWarning ?? '';
        case 'running':
        case 'interacting':
        default:
            return css.stInfo ?? '';
    }
}
/** 状态 SVG 图标（照原型 4 种：成功对勾 / 运行转圈 / 失败叉 / 暂停叹号）。 */
function StatusIcon({ status }) {
    switch (status) {
        case 'completed':
            return (_jsxs("svg", { viewBox: "0 0 14 14", fill: "none", "aria-hidden": true, children: [_jsx("circle", { cx: "7", cy: "7", r: "5.5", stroke: "currentColor", strokeWidth: "1.4", fill: "currentColor" }), _jsx("path", { d: "M4.6 7.2l1.6 1.6 3.2-3.4", stroke: "#fff", strokeWidth: "1.3", fill: "none", strokeLinecap: "round" })] }));
        case 'failed':
            return (_jsxs("svg", { viewBox: "0 0 14 14", fill: "none", "aria-hidden": true, children: [_jsx("circle", { cx: "7", cy: "7", r: "5.5", stroke: "currentColor", strokeWidth: "1.4" }), _jsx("path", { d: "M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" })] }));
        case 'paused':
            return (_jsxs("svg", { viewBox: "0 0 14 14", fill: "none", "aria-hidden": true, children: [_jsx("circle", { cx: "7", cy: "7", r: "5.5", stroke: "currentColor", strokeWidth: "1.4" }), _jsx("path", { d: "M7 4v3.2", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }), _jsx("circle", { cx: "7", cy: "10", r: "0.7", fill: "currentColor" })] }));
        case 'running':
        case 'interacting':
        default:
            return (_jsxs("svg", { viewBox: "0 0 14 14", fill: "none", "aria-hidden": true, children: [_jsx("circle", { cx: "7", cy: "7", r: "5.5", stroke: "currentColor", strokeWidth: "1.4" }), _jsx("path", { d: "M7 1.5a5.5 5.5 0 1 1-5.5 5.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })] }));
    }
}
/** 相对时间 → 字典文案。 */
function formatTime(t, rel) {
    if (rel === undefined)
        return '';
    switch (rel.kind) {
        case 'justNow':
            return t('run.time.justNow');
        case 'minutes':
            return t('run.time.minutesAgo', { count: rel.count });
        case 'hours':
            return t('run.time.hoursAgo', { count: rel.count });
        case 'days':
            return t('run.time.daysAgo', { count: rel.count });
        case 'date':
            return rel.text;
    }
}
/** 单行消息（agent 内嵌框 / 失败·暂停列表共用）。 */
function ChatLineRow({ line }) {
    return (_jsxs("div", { className: `${css.chatLine} ${line.kind === 'tool' ? css.chatLineTool : css.chatLineAssistant}`, children: [_jsx("span", { className: css.chatWho, children: line.who }), _jsx("span", { className: css.chatTxt, children: line.text })] }));
}
/** 最近 N 条消息列表（失败/暂停态）。 */
function LastMessages({ item, t }) {
    const lines = item.messages ?? [];
    const failed = item.status === 'failed';
    const listClass = failed ? css.agentLastListFailed : css.agentLastListPaused;
    const fallback = failed
        ? (item.error !== undefined ? [{ who: `${item.name} · agent`, text: item.error, kind: 'assistant' }] : [])
        : [{ who: `${item.name} · agent`, text: t('step.paused.hint'), kind: 'assistant' }];
    const shown = lines.length > 0 ? lines.slice(-5) : fallback;
    return (_jsx("div", { className: `${css.agentLastList} ${listClass}`, children: _jsx("div", { className: css.agentLastScroll, children: shown.map((line, index) => (_jsx(ChatLineRow, { line: line }, index))) }) }));
}
/** 单条 agent 消息（一个 executedStep）。 */
function AgentMsg({ item, t, nowIso, openSession }) {
    const running = item.status === 'running' || item.status === 'interacting';
    const rel = relativeTimeOf(item.time, nowIso);
    // 仅真实子代理步骤（agent/skill/mcp，非合成会话）的标题可点击跳 DSH 子代理页；
    // shell/prompt 的 childId 是合成占位（无真实会话），点击无效，渲染为纯文本。
    const navigable = item.childId !== undefined && item.synthetic !== true;
    return (_jsxs("div", { className: css.agentMsg, "data-tl-step": true, children: [_jsxs("div", { className: css.agentHead, children: [_jsx("span", { className: `${css.avatar} ${css.avatarAgent}`, "aria-hidden": true, children: _jsx(IconSparkle16, {}) }), navigable ? (_jsx("button", { type: "button", className: css.authorLink, title: t('step.open', { name: item.name }), onClick: () => { openSession(item.childId); }, children: item.name })) : (_jsx("span", { className: css.author, children: item.name })), item.loopLabel !== undefined && _jsx("span", { className: css.loopLabel, children: item.loopLabel }), item.attemptIndex !== undefined && item.attemptIndex > 0 && (_jsx("span", { className: css.loopLabel, children: t('run.step.attempt', { n: item.attemptIndex + 1 }) })), rel !== undefined && _jsx("span", { className: css.time, children: formatTime(t, rel) }), _jsxs("span", { className: `${css.st} ${statusClass(item.status)}`, children: [_jsx(StatusIcon, { status: item.status }), _jsx("span", { className: css.stLbl, children: t(STEP_STATUS_KEYS[item.status]) })] })] }), item.status === 'completed' && item.outputText !== undefined && (_jsx("div", { className: css.md, children: _jsx(MessageText, { text: item.outputText }) })), running && (item.messages !== undefined && item.messages.length > 0
                ? (_jsx("div", { className: css.agentChat, children: _jsx("div", { className: css.agentChatScroll, children: item.messages.map((line, index) => (_jsx(ChatLineRow, { line: line }, index))) }) }))
                : _jsxs("div", { className: css.agentBodyRun, children: [t('run.step.status.running'), "\u2026"] })), item.status === 'failed' && _jsx(LastMessages, { item: item, t: t }), item.status === 'paused' && _jsx(LastMessages, { item: item, t: t })] }));
}
/** 用户消息：右侧气泡 + kind 徽标 + meta。 */
function UserMsg({ item, t, nowIso }) {
    const rel = relativeTimeOf(item.time, nowIso);
    // 消息种类徽标（input/resume/retry/answer）；旧实例无 messageKind 时省略。
    const kindKey = item.messageKind === undefined
        ? undefined
        : item.messageKind === 'input' ? 'run.user.kind.input'
            : item.messageKind === 'resume' ? 'run.user.kind.resume'
                : item.messageKind === 'retry' ? 'run.user.kind.retry'
                    : item.messageKind === 'answer' ? 'run.user.kind.answer'
                        : undefined;
    return (_jsxs("div", { className: css.userMsg, "data-tl-user": true, children: [_jsx("div", { className: css.bubble, children: item.content }), _jsxs("div", { className: css.userMeta, children: [kindKey !== undefined && _jsx("span", { className: css.loopLabel, children: t(kindKey) }), rel !== undefined && _jsxs("span", { className: css.time, children: [formatTime(t, rel), " \u00B7 ", t('run.time.you')] })] })] }));
}
/** 渲染执行详情对话流。 */
export function UnifiedTimeline({ t, items, openSession }) {
    // 每次渲染取「现在」，运行中轮询会带动重渲染，保持相对时间新鲜。
    const nowIso = new Date().toISOString();
    return (_jsxs("div", { className: css.flow, "data-sandore-timeline": true, children: [items.length === 0 && _jsx("p", { className: css.empty, children: t('run.trajectory.empty') }), items.map((item, index) => (item.kind === 'user'
                ? _jsx(UserMsg, { item: item, t: t, nowIso: nowIso }, `user-${index}`)
                : _jsx(AgentMsg, { item: item, t: t, nowIso: nowIso, openSession: openSession }, `${item.stepId}-${index}`)))] }));
}
//# sourceMappingURL=UnifiedTimeline.js.map