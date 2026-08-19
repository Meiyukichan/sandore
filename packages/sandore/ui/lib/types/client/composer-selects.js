import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * ComposerSelects：执行详情输入框的两个选择器（模型 / 权限）。
 *
 * 行为与 DSH web 主 session 完全一致：
 * - 模型：`modelDirectory`（复用 DSH `ctx.modelDirectories` 的 per-session 目录）
 *   点击 → 两级菜单（模型 / 推理等级）→ 选择经 `select` → `selectModel` 绑定到
 *   当前实例会话（instanceId）；触发器显示当前模型 + 推理等级。
 * - 权限：从会话 `projections.permissions` 读权限投影，点击 → 菜单列出预设
 *   （read-only / workspace-write / danger-full-access）→ 选择后经 `runCommand`
 *   执行 `/permission <id>`（与主 session 同一命令路径）；`danger-full-access`
 *   先弹风险确认。触发器显示当前权限名 + 盾牌图标。
 * 样式照 DSH ModelSelect.module.css / PermissionSelect.module.css。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/composer-selects
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './composer-selects.module.css';
/** 完整访问权限预设值（与 DSH PermissionSelect 的 FULL_ACCESS 一致）。 */
const FULL_ACCESS = 'danger-full-access';
/** 权限投影与命令查询均不可用时的降级占位（显示但锁定；仅旧日志实例触发）。 */
const FALLBACK_PERMISSION = {
    options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: FULL_ACCESS, name: FULL_ACCESS },
    ],
    currentValue: 'workspace-write',
};
/** 渲染模型触发器 + 两级菜单（复用 DSH 的模型目录数据面）。 */
export function ModelSelectSandore({ t, directory, locked }) {
    const state = useSyncExternalStore(fn => directory.store.subscribe(fn), () => directory.store.getSnapshot());
    const [open, setOpen] = useState(false);
    const [pane, setPane] = useState('root');
    const [toast, setToast] = useState(null);
    const toastSeq = useRef(0);
    const rootRef = useRef(null);
    const lastActionRef = useRef('load');
    const choices = useMemo(() => state.groups.flatMap(group => group.models.map(model => ({
        group,
        model,
        selection: {
            provider: group.id,
            model: model.id,
            ...model.reasoning?.defaultEffort === undefined
                ? {}
                : { reasoningEffort: model.reasoning.defaultEffort },
        },
    }))), [state.groups]);
    const selectedIndex = state.current === null
        ? -1
        : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model);
    const currentChoice = choices[selectedIndex];
    const reasoning = currentChoice?.model.reasoning;
    const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
    const effortLabel = reasoning === undefined
        ? undefined
        : effectiveEffort === undefined
            ? t('composer.model.effortDefault')
            : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort;
    const effortChoices = useMemo(() => reasoning === undefined
        ? []
        : [
            ...reasoning.defaultEffort === undefined
                ? [{ key: 'provider-default', effort: undefined, label: t('composer.model.effortDefault') }]
                : [],
            ...reasoning.efforts.map(level => ({
                key: `effort:${level.id}`,
                effort: level.id,
                label: level.name,
                ...level.description === undefined ? {} : { description: level.description },
            })),
        ], [reasoning, t]);
    const busy = state.status === 'selecting';
    const reload = () => {
        lastActionRef.current = 'load';
        void directory.load().catch(() => { });
    };
    useEffect(() => {
        if (locked) {
            setOpen(false);
            return;
        }
        if (!locked) {
            lastActionRef.current = 'load';
            void directory.load().catch(() => { });
        }
    }, [locked, directory]);
    useEffect(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            if (!rootRef.current?.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside); };
    }, [open]);
    if (state.routable === false)
        return null;
    const show = () => {
        setPane('root');
        setOpen(true);
        reload();
    };
    const close = (restoreFocus = false) => {
        setOpen(false);
        setPane('root');
        if (restoreFocus)
            queueMicrotask(() => { rootRef.current?.querySelector('button')?.focus(); });
    };
    const settleSelection = (accepted) => {
        if (accepted) {
            close(true);
            return;
        }
        const message = directory.store.getSnapshot().error;
        if (message !== null) {
            toastSeq.current += 1;
            setToast({ seq: toastSeq.current, text: t('composer.model.error', { message }) });
        }
    };
    const choose = (selection) => {
        if (state.current?.provider === selection.provider && state.current.model === selection.model) {
            close(true);
            return;
        }
        lastActionRef.current = 'select';
        void directory.select(selection).then(() => { settleSelection(true); }, () => { settleSelection(false); });
    };
    const chooseEffort = (effort) => {
        if (state.current === null)
            return;
        if (effectiveEffort === effort) {
            close(true);
            return;
        }
        const selection = {
            provider: state.current.provider,
            model: state.current.model,
            ...effort === undefined ? {} : { reasoningEffort: effort },
        };
        lastActionRef.current = 'select';
        void directory.select(selection).then(() => { settleSelection(true); }, () => { settleSelection(false); });
    };
    const modelLabel = currentChoice?.model.name ?? t('composer.model.fallback');
    const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
    const triggerAria = currentChoice === undefined
        ? t('composer.model.fallback')
        : effortLabel === undefined
            ? t('composer.model.aria', { model: modelLabel })
            : t('composer.model.ariaEffort', { model: modelLabel, effort: effortLabel });
    return (_jsxs("div", { ref: rootRef, className: css.msRoot, children: [_jsxs("button", { type: "button", className: css.trigger, "aria-label": triggerAria, "aria-haspopup": "menu", "aria-expanded": open, title: triggerLabel, disabled: locked, onClick: () => { if (open) {
                    close();
                }
                else {
                    show();
                } }, children: [_jsx("span", { className: css.triggerLabel, children: modelLabel }), effortLabel !== undefined && _jsx("span", { className: css.triggerEffort, children: effortLabel }), _jsx("span", { className: `${css.chevron} ${open ? css.chevronOpen : ''}`, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) })] }), open && (_jsxs("div", { className: css.menu, role: "menu", "aria-label": t('composer.model.menu'), "aria-busy": state.status === 'loading' || busy, children: [pane === 'root' && (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", role: "menuitem", className: css.cell, onClick: () => { setPane('model'); }, children: [_jsx("span", { className: css.cellLabel, children: t('composer.model.title') }), _jsx("span", { className: css.cellValue, children: modelLabel }), _jsx("span", { className: css.cellChevron, "aria-hidden": true, children: _jsx(IconChevronRightOutline14, {}) })] }), reasoning !== undefined && (_jsxs("button", { type: "button", role: "menuitem", className: css.cell, onClick: () => { setPane('effort'); }, children: [_jsx("span", { className: css.cellLabel, children: t('composer.model.effort') }), _jsx("span", { className: css.cellValue, children: effortLabel }), _jsx("span", { className: css.cellChevron, "aria-hidden": true, children: _jsx(IconChevronRightOutline14, {}) })] }))] })), pane === 'model' && (_jsxs(_Fragment, { children: [state.status === 'loading' && _jsx("div", { className: css.status, children: t('composer.model.loading') }), state.error !== null && lastActionRef.current === 'load' && (_jsxs("div", { className: css.error, children: [_jsx("span", { children: t('composer.model.error', { message: state.error }) }), _jsx("button", { type: "button", className: css.retry, onClick: reload, children: t('composer.model.reload') })] })), state.failures.map(failure => (_jsxs("div", { className: css.warning, children: [_jsx("span", { children: t('composer.model.warning', { name: failure.name, message: failure.message }) }), _jsx("button", { type: "button", className: css.retry, onClick: reload, children: t('composer.model.reload') })] }, failure.id))), _jsx("div", { className: css.groups, children: state.groups.map(group => (_jsxs("section", { role: "group", "aria-label": group.name, className: css.group, children: [_jsx("div", { className: css.groupTitle, children: group.name }), group.models.map(model => {
                                            const selected = state.current?.provider === group.id && state.current.model === model.id;
                                            return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": selected, className: `${css.option} ${selected ? css.selected : ''}`, title: model.name, disabled: busy, onClick: () => { choose({ provider: group.id, model: model.id }); }, children: [_jsxs("span", { className: css.optionCopy, children: [_jsx("span", { className: css.modelName, children: model.name }), model.description !== undefined && (_jsx("span", { className: css.description, children: model.description }))] }), _jsx("span", { className: css.check, children: selected ? _jsx(IconCheckOutline16, {}) : null })] }, model.id));
                                        })] }, group.id))) }), state.status === 'ready' && choices.length === 0 && (_jsx("div", { className: css.empty, children: t('composer.model.empty') }))] })), pane === 'effort' && (_jsx(_Fragment, { children: effortChoices.length === 0
                            ? _jsx("div", { className: css.empty, children: t('composer.model.emptyEfforts') })
                            : effortChoices.map(level => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": effectiveEffort === level.effort, className: `${css.option} ${effectiveEffort === level.effort ? css.selected : ''}`, disabled: busy, onClick: () => { chooseEffort(level.effort); }, children: [_jsxs("span", { className: css.optionCopy, children: [_jsx("span", { className: css.modelName, children: level.label }), level.description !== undefined && (_jsx("span", { className: css.description, children: level.description }))] }), _jsx("span", { className: css.check, children: effectiveEffort === level.effort ? _jsx(IconCheckOutline16, {}) : null })] }, level.key))) }))] })), toast !== null && (_jsx(Toast, { text: toast.text, onDone: () => { setToast(null); } }, toast.seq))] }));
}
// ── 权限选择（照 DSH ui-conversation PermissionSelect） ────────────────────
/** 权限盾牌 glyph（照 DSH PermissionSelect 的 3 种：对勾 / 铅笔 / 感叹）。 */
function permissionGlyph(value) {
    switch (value) {
        case 'read-only':
            return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [_jsx("path", { d: "M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z", stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), _jsx("path", { d: "M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z", fill: "currentColor" })] }));
        case FULL_ACCESS:
            return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [_jsx("path", { d: "M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z", stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), _jsx("path", { d: "M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z", fill: "currentColor" }), _jsx("path", { d: "M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z", fill: "currentColor" })] }));
        default:
            return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [_jsx("path", { d: "M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z", fill: "currentColor" }), _jsx("path", { d: "M11.3525 5.64688V6.85688H5V5.64688H11.3525Z", fill: "currentColor" }), _jsx("path", { d: "M9.5824 8.29376V9.50376H5V8.29376H9.5824Z", fill: "currentColor" }), _jsx("path", { d: "M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z", fill: "currentColor" }), _jsx("path", { d: "M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z", fill: "currentColor" })] }));
    }
}
/** 机器名 → 展示名（`workspace-write` → `Workspace Write`）。 */
function displayName(name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
        return name;
    return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
/** 渲染权限触发器 + 菜单 + 完全访问确认（行为照 DSH PermissionSelect）。 */
export function PermissionSelectSandore({ t, value, locked, runCommand, queryValue }) {
    const [open, setOpen] = useState(false);
    const [confirmation, setConfirmation] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [pendingPick, setPendingPick] = useState(false);
    const [fallback, setFallback] = useState(undefined);
    const [fallbackFailed, setFallbackFailed] = useState(false);
    const rootRef = useRef(null);
    // 投影缺失 → 命令查询回退（会话未被 DSH 打开过时投影为空）；查询失败（如
    // 旧日志实例无法 resume）降级为占位并锁定，保证选择器不消失。
    useEffect(() => {
        if (value !== undefined) {
            setFallback(undefined);
            setFallbackFailed(false);
            return;
        }
        let alive = true;
        void queryValue().then(next => {
            if (!alive)
                return;
            if (next === undefined)
                setFallbackFailed(true);
            else
                setFallback(next);
        });
        return () => { alive = false; };
    }, [value, queryValue]);
    useEffect(() => {
        if (!locked && (value ?? fallback) !== undefined)
            return;
        setOpen(false);
        setAcknowledged(false);
        setConfirmation(false);
    }, [locked, value, fallback]);
    useEffect(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            if (!rootRef.current?.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside); };
    }, [open]);
    // 投影 → 查询回退 → 降级占位（锁定）。
    const degraded = value === undefined && fallback === undefined && fallbackFailed;
    const effective = value ?? fallback ?? (degraded ? FALLBACK_PERMISSION : undefined);
    const lockedOrDegraded = locked || degraded;
    if (effective === undefined)
        return null;
    const currentValue = effective.currentValue;
    const current = effective.options.find(option => option.value === currentValue);
    const busy = pendingPick;
    const submit = (id) => {
        setPendingPick(true);
        void runCommand(`/permission ${id}`)
            .catch(() => false)
            .then(() => { setPendingPick(false); });
    };
    const choose = (id) => {
        setOpen(false);
        if (id === currentValue)
            return;
        if (id === FULL_ACCESS) {
            setAcknowledged(false);
            setConfirmation(true);
            return;
        }
        submit(id);
    };
    const confirmFullAccess = () => {
        if (lockedOrDegraded || !acknowledged || !confirmation)
            return;
        setConfirmation(false);
        submit(FULL_ACCESS);
    };
    const glyph = permissionGlyph(currentValue);
    return (_jsxs("div", { ref: rootRef, className: css.msRoot, children: [_jsxs("button", { type: "button", className: css.trigger, "aria-label": t('run.permission.title'), title: current?.description, disabled: lockedOrDegraded || busy, onClick: () => { setOpen(!open); }, children: [_jsx("span", { className: css.triggerIcon, "aria-hidden": true, children: glyph }), _jsx("span", { className: css.triggerLabel, children: current === undefined
                            ? displayName(currentValue)
                            : current.value === FULL_ACCESS
                                ? 'Full access'
                                : displayName(current.name) }), _jsx("span", { className: `${css.chevron} ${open ? css.chevronOpen : ''}`, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) })] }), open && (_jsx("div", { className: css.menu, role: "menu", "aria-label": t('run.permission.title'), children: effective.options
                    .filter(option => option.value !== 'custom')
                    .map(option => {
                    const selected = option.value === currentValue;
                    const icon = permissionGlyph(option.value);
                    return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": selected, className: `${css.option} ${selected ? css.selected : ''}`, disabled: busy, onClick: () => { choose(option.value); }, children: [_jsx("span", { className: css.optionIcon, "aria-hidden": true, children: icon }), _jsx("span", { className: css.optionCopy, children: _jsx("span", { className: css.modelName, children: option.value === FULL_ACCESS ? 'Full access' : displayName(option.name) }) }), _jsx("span", { className: css.check, children: selected ? _jsx(IconCheckOutline16, {}) : null })] }, option.value));
                }) })), confirmation && (_jsx("div", { className: css.riskMask, children: _jsxs("div", { className: css.riskCard, role: "alertdialog", "aria-modal": "true", children: [_jsx("div", { className: css.riskTitle, children: t('composer.permission.confirmTitle') }), _jsx("div", { className: css.riskDesc, children: t('composer.permission.confirmDesc') }), _jsxs("label", { className: css.riskAck, children: [_jsx("input", { type: "checkbox", checked: acknowledged, disabled: lockedOrDegraded, onChange: event => { setAcknowledged(event.target.checked); } }), _jsx("span", { children: t('composer.permission.acknowledge') })] }), _jsxs("div", { className: css.riskActions, children: [_jsx("button", { type: "button", className: css.riskCancel, onClick: () => { setConfirmation(false); setAcknowledged(false); }, children: t('composer.permission.cancel') }), _jsx("button", { type: "button", className: css.riskConfirm, disabled: !acknowledged || lockedOrDegraded, onClick: confirmFullAccess, children: t('composer.permission.enable') })] })] }) }))] }));
}
//# sourceMappingURL=composer-selects.js.map