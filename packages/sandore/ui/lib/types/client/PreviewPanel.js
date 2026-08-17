import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * PreviewPanel：执行态右栏文件/结果预览（默认隐藏，树形导航叶子点击后出现）。
 *
 * result 叶子显示 Step 输出文本（MessageText 渲染）；artifact 叶子显示文件路径
 * 元信息（产物无内容读取 RPC，正文即路径集合）。关闭按钮隐藏右栏并清选中态。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/PreviewPanel
 */
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './preview.module.css';
/** 渲染右栏预览。 */
export function PreviewPanel({ t, target, onClose }) {
    if (target === null)
        return null;
    return (_jsxs("div", { className: css.root, "data-sandore-preview": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: target.name }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.close, "aria-label": t('run.preview.close'), title: t('run.preview.close'), onClick: onClose, children: "\u2715" })] }), _jsxs("div", { className: css.body, children: [_jsxs("div", { className: css.meta, children: [_jsxs("span", { children: [target.kind === 'result' ? '📝' : '📄', " ", target.kind === 'result' ? t('run.result') : t('run.artifact')] }), target.meta !== undefined && _jsx("span", { children: target.meta })] }), target.text !== undefined && (target.kind === 'result'
                        ? _jsx("div", { className: css.text, children: _jsx(MessageText, { text: target.text }) })
                        : _jsx("pre", { className: css.file, children: target.text }))] })] }));
}
//# sourceMappingURL=PreviewPanel.js.map