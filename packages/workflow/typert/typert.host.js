/* Hand-written Host FaceModel — 手写基线，非 generator 产物。 */

// Host 侧严格描述符（invocations）直接复用 Remote 客户端生成物
// `TYPERT_REMOTE.descriptors`：两端共享同一组 endpoint/参数/结果 schema，
// 保证客户端调用与 Host 校验始终一致，也避免手写两份漂移。
//
// typert-loader 在插件挂载时加载本 manifest 并注册进 `ctx.typert`，
// Gateway 的 `resolveDescriptor` 优先命中 `ctx.typert.local` 的严格描述符，
// 不再依赖 SRC fallback 的 `@Remote` 标记 WeakMap（该路径要求 plugin 与
// Gateway 解析到同一份 `@deepseek-ai/dsh-typert-protocol` 模块实例，而
// 插件经 profile 软链到仓库后经 pnpm 副本解析，Gateway 走 npx 缓存副本，
// 两份实例的 markers 互不可见，SRC 发现必然为空）。
//
// `schemas` 留空（invocations 均内联 codec，无跨包 schema 引用）；
// `model` 三数组留空（validateTypertManifest 仅要求其为数组）。完整
// FaceModel 待 typert generator 支持第三方仓库后重新生成。
import { TYPERT_REMOTE } from './typert.remote-client.js'

export const TYPERT = {
  package: 'dsh-sandore',
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: { services: [], events: [], objects: [] },
}
