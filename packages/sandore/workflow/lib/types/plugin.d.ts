/**
 * sandore workflow 包的复合插件（默认导出）。
 *
 * `workflow` 包由三个独立 Service 组成一条依赖链：
 *
 * ```
 * storageDomain ──▶ SandorePersistence   (sandorePersistence)
 * sandorePersistence + sessions + … ──▶ SandoreEngineRuntime (sandoreEngine)
 * sandorePersistence + sandoreEngine + llm ──▶ SandoreRemote (sandore RPC)
 * ```
 *
 * 单元测试里三者经 `ctx.plugin(...)` 逐个注册，但生产 cordis.yml 只加载包默认
 * 导出。因此本复合插件在 `[Service.init]` 中按拓扑序依次 `ctx.plugin(...)` 注册
 * 三个子服务，使 `sandorePersistence` / `sandoreEngine` / `sandore` RPC 全部对
 * 宿主可用；自身不 `inject` 任何子服务（它们各自声明依赖），Config 透传
 * `SandoreEngineRuntime.Config`。
 *
 * @module @deepseek-ai/dsh-sandore-workflow/plugin
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { SandoreConfig } from './seam.ts';
export default class SandoreWorkflowPlugin extends Service {
    private readonly config;
    static Config: import("@deepseek-ai/schemastery").default<SandoreConfig>;
    constructor(ctx: Context, config: SandoreConfig);
    protected [Service.init](): Promise<void>;
}
//# sourceMappingURL=plugin.d.ts.map