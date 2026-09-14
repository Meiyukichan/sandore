/**
 * react-dom 类型垫片：sandore ui 包不声明 react-dom 依赖（web 宿主在运行时注入），
 * 但 ImageLightbox 的 body portal 与 composer 的 chip decorator portal 需要
 * `react-dom` 的 `createPortal` 类型。仅声明最小表面；运行时解析由宿主 bundle 提供。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/react-dom
 */
declare module 'react-dom' {
  import type { ReactPortal, ReactNode } from 'react'
  /**
   * Render a subtree into a DOM node outside the React root.
   * @param children - the subtree to portal.
   * @param container - the DOM node the subtree renders into.
   * @param key - optional portal identity (decorator NodeKey; keeps DOM identity
   *   stable across edits around a chip, matching @lexical/react).
   */
  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: string | null,
  ): ReactPortal
}
