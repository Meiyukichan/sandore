/**
 * sandore 工作流引擎包入口。
 *
 * 默认导出 `SandoreWorkflowPlugin`（复合插件，见 `plugin.ts`）——它在
 * `[Service.init]` 中注册 `SandorePersistence` / `SandoreEngineRuntime` /
 * `SandoreRemote` 三个子服务，使 cordis.yml 单条目挂载即可提供
 * `sandorePersistence` / `sandoreEngine` / `sandore` RPC。`SandoreEngine`
 * 抽象 Service、13 个 `sandore/*` 事件双声明与 `SandoreEngineStub` 桩以
 * named export 提供（见 `seam.ts`）。
 */
export type * from './types.ts'
export * from './errors.ts'
export * from './schema.ts'
export * from './domain.ts'
export * from './yaml-parser.ts'
export type * from './shell.ts'
export * from './seam.ts'
export * from './dag-navigator.ts'
export * from './remote.ts'

import SandoreEngineRuntime from './workflow-engine.ts';
import SandoreWorkflowPlugin from './plugin.ts';

export { SandoreEngineRuntime, SandoreWorkflowPlugin }
export default SandoreWorkflowPlugin
