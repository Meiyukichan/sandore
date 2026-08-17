/* Hand-written minimal Host FaceModel type — 手写基线，非 generator 产物。 */

/** 空 Host FaceModel：字段满足 typert-loader 校验，RPC 走 SRC fallback。 */
export declare const TYPERT: {
  readonly package: '@deepseek-ai/dsh-sandore-workflow'
  readonly face: 'host'
  readonly schemas: readonly unknown[]
  readonly invocations: readonly unknown[]
  readonly model: {
    readonly services: readonly unknown[]
    readonly events: readonly unknown[]
    readonly objects: readonly unknown[]
  }
}
