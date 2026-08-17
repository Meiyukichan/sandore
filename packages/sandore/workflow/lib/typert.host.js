/* Hand-written minimal Host FaceModel — 手写基线，非 generator 产物。 */

// 空 FaceModel 是合法的：typert-loader 的 validateTypertManifest 只要求
// `model.services` / `model.events` / `model.objects` 三者为数组、`schemas` /
// `invocations` 为数组、`face === 'host'`。Host 侧 RPC 的真实注册与路由走
// Gateway 的 SRC fallback（`SandoreRemote extends TypertRemoteService` 的
// `typertRemote` 绑定 + `@Remote` 标记），不依赖本 manifest 的 invocations，
// 因此此处留空即可；完整 FaceModel 待 typert generator 支持第三方仓库后重新生成。
export const TYPERT = {
  package: '@deepseek-ai/dsh-sandore-workflow',
  face: 'host',
  schemas: [],
  invocations: [],
  model: { services: [], events: [], objects: [] },
}
