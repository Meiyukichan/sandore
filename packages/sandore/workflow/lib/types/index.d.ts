/**
 * sandore 工作流引擎包入口。
 *
 * 默认导出 `SandoreEngineRuntime`（真实引擎运行时）；`SandoreEngine` 抽象
 * Service、13 个 `sandore/*` 事件双声明与 `SandoreEngineStub` 桩以 named
 * export 提供（见 `seam.ts`）。
 */
export type * from './types.ts';
export * from './errors.ts';
export * from './schema.ts';
export * from './domain.ts';
export * from './yaml-parser.ts';
export type * from './shell.ts';
export * from './seam.ts';
export * from './dag-navigator.ts';
export * from './remote.ts';
import SandoreEngineRuntime from './workflow-engine.ts';
export { SandoreEngineRuntime };
export default SandoreEngineRuntime;
//# sourceMappingURL=index.d.ts.map