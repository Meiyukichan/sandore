/* Hand-written Host FaceModel type — 手写基线，非 generator 产物。 */

import type { TYPERT_REMOTE } from './typert.remote-client.js'

/** Host FaceModel：invocations 复用 Remote 客户端 descriptors（严格描述符）。 */
export declare const TYPERT: {
  readonly package: '@deepseek-ai/dsh-sandore-workflow'
  readonly face: 'host'
  readonly schemas: readonly unknown[]
  readonly invocations: typeof TYPERT_REMOTE['descriptors']
  readonly model: {
    readonly services: readonly unknown[]
    readonly events: readonly unknown[]
    readonly objects: readonly unknown[]
  }
}
