/**
 * DSH 值导入的 ambient 类型垫片（仅类型面；运行时不参与解析）。
 *
 * 背景：registry 版 `@deepseek-ai/dsh-client-ui-conversation` / `dsh-client-ui-renderer`
 * 的 npm 产物不包含 `src/`（`files` 仅 lib），而 `ChatView` / `observableHook` 只在
 * DSH 源码里导出（client bundle 的公开面只暴露 apply/inject）。sandore 选择构建期
 * 源码级复用（tsdown `dshSourceAlias` 指向 deepseek-harness 工作区源码内联），因此
 * tsc 侧需要用本垫片补上这两个值导入的类型面：
 * - `ChatView` 的类型面直接复用 registry 包 `./client` 已导出的 `ChatViewSlotProps`
 *   （rc.6 与运行时 rc.8 的插槽契约结构一致，构建期已核对）；
 * - `observableHook` 的类型面复用 `@deepseek-ai/dsh-client-ui-slots` 的
 *   `HostObservable` / `SnapshotSelectorHook`（DSH 渲染栈的公共契约）。
 *
 * 注意：本文件只声明模块形状，不参与运行时；tsdown 打包时经 resolveId 别名解析到
 * 真实源码文件，两侧签名必须保持一一对应（改 DSH 值签名时同步更新这里）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dsh-chat-shim
 */
declare module '@deepseek-ai/dsh-client-ui-conversation/src/client/chat/ChatView' {
  import type { ChatViewSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
  import type { ReactElement } from 'react'

  /** 复用 DSH 现成会话页组件（渲染栈由 tsdown 从 harness 源码内联）。 */
  export function ChatView(props: ChatViewSlotProps): ReactElement
}

declare module '@deepseek-ai/dsh-client-ui-renderer/src/client/session-provider' {
  import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

  /** 把任意 observable 快照源绑成类型化 selector hook（DSH 渲染器同一实现）。 */
  export function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T>
}
