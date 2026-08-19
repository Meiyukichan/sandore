/**
 * composer 选择器的运行时注入面（模型目录 / 会话权限投影 / 命令执行）。
 *
 * 编译期不依赖 DSH 的 ui-model-selection / ui-permission-presets 包（沙盒仓库
 * 未链接它们），这里按 harness 的 wire 形状自声明最小类型；运行时复用 dev 实例
 * 已加载的 `ctx.modelDirectories` 服务、会话 projections 与 `remote.commands`，
 * 行为与 DSH 主 session 的模型/权限选择完全一致（同一数据源、同一 RPC）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/model-faces
 */
/**
 * 轻量每会话模型目录（对齐 DSH ui-model-selection 的 `ModelDirectory`）：
 * 直接走 `connection.api.sessions.models/selectModel`（同一 RPC、同一行为），
 * 不依赖 DSH 会话 scope（sandore 实例会话未必被 DSH 会话列表 staged）。
 */
export class SandoreModelDirectory {
    api;
    sessionId;
    store = {
        getSnapshot: () => this.state,
        subscribe: fn => {
            this.listeners.add(fn);
            return () => { this.listeners.delete(fn); };
        },
    };
    state = {
        current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
    };
    listeners = new Set();
    generation = 0;
    disposed = false;
    constructor(api, sessionId) {
        this.api = api;
        this.sessionId = sessionId;
    }
    /** 刷新目录（失败保留上次好数据；打开菜单时调用，行为同 DSH）。 */
    async load() {
        const generation = ++this.generation;
        this.update({ status: 'loading', error: null });
        const { result } = await this.api.models({ sessionId: this.sessionId });
        if (this.disposed || generation !== this.generation) {
            if (!result.ok)
                throw new Error(`${result.error?.code}: ${result.error?.message}`);
            return result.value;
        }
        if (!result.ok) {
            this.update({ status: 'error', error: `${result.error?.code}: ${result.error?.message}` });
            throw new Error(`session.models failed: ${result.error?.code}: ${result.error?.message}`);
        }
        this.update({
            current: result.value.current,
            routable: result.value.routable,
            groups: result.value.groups,
            failures: result.value.failures,
            status: 'ready',
            error: null,
        });
        return result.value;
    }
    /** 选择完整 provider/model/推理等级（提交 `selectModel` 绑定会话）。 */
    async select(selection) {
        const generation = ++this.generation;
        this.update({ status: 'selecting', error: null });
        const { result } = await this.api.selectModel({
            sessionId: this.sessionId,
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: selection.reasoningEffort },
        });
        if (this.disposed || generation !== this.generation) {
            if (!result.ok)
                throw new Error(`${result.error?.code}: ${result.error?.message}`);
            return;
        }
        if (!result.ok) {
            this.update({ status: 'error', error: `${result.error?.code}: ${result.error?.message}` });
            throw new Error(`session.selectModel failed: ${result.error?.code}: ${result.error?.message}`);
        }
        this.update({ current: result.value.selected, routable: true, status: 'ready', error: null });
    }
    /** 会话 scope 拆除时调用（沙盒目录随组件卸载回收）。 */
    dispose() {
        this.disposed = true;
        this.listeners.clear();
    }
    update(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners)
            listener();
    }
}
/**
 * 解析 `/permission`（无参）命令报告文本：
 * `current preset workspace-write (available: workspace-write, danger-full-access)`。
 * 权限投影缺失时作为回退数据源（与 DSH 主 session 的权限选择同一命令路径）。
 */
export function parsePermissionReport(text) {
    const match = /^current preset (\S+) \(available: ([^)]+)\)$/.exec(text.trim());
    if (match === null)
        return undefined;
    const currentValue = match[1];
    const options = match[2].split(',').map(part => part.trim()).filter(part => part !== '').map(name => ({ value: name, name }));
    if (options.length === 0)
        return undefined;
    return { options, currentValue };
}
//# sourceMappingURL=model-faces.js.map