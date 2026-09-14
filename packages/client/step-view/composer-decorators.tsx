/**
 * composer-decorators.tsx（批 B1）：引用芯片（chip）的 portal 渲染圈。
 *
 * 背景：`@step` 的 chip 是 DSH 输入内核（ui-conversation 的 SessionInputShell）里
 * 的 Lexical `ReferenceChipNode`（DecoratorNode），它的 React 面由
 * `editor.getDecorators()` / `registerDecoratorListener()` 发布，需要宿主把它们
 * portal 进各自 `editor.getElementByKey(key)` 的宿主元素。DSH 自己在
 * `ui-conversation/src/client/input/editor/DecoratorPortals.tsx` 里做了这件事
 * （@lexical/react 的 ComposerPlugin 内部同款）；sandore 的壳复刻同一段循环
 * （约 40 行，只读参考，不 import）。
 *
 * 与 DSH 版的差异：state 用 `setDecorators` 且 `editor` 可为 null（未解析到内核 →
 * 不渲染任何 portal）。NodeKey 作为 portal 的 React key：文本编辑围绕 chip 增删时
 * chip 的 DOM 身份不重挂（与 DSH 一致）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-decorators
 */
import { useLayoutEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { StepComposerEditorLike } from './dsh-composer.ts'

/** 芯片 portal 圈 props。 */
export interface StepComposerDecoratorsProps {
  /** 已绑定的编辑器（未解析到内核 → null，不渲染）。 */
  readonly editor: StepComposerEditorLike | null
}

/**
 * 把每个 decorator 的 React 面 portal 进它的编辑器宿主元素。
 * @param props - 要观察的编辑器。
 * @returns 当前 portal 集合。
 */
export function StepComposerDecorators({ editor }: StepComposerDecoratorsProps): ReactNode {
  const [decorators, setDecorators] = useState<Record<string, ReactElement>>(
    () => editor === null ? {} : editor.getDecorators<ReactElement>(),
  )
  useLayoutEffect(() => {
    if (editor === null) {
      setDecorators({})
      return undefined
    }
    setDecorators(editor.getDecorators<ReactElement>())
    // 注册返回的 logger 用于解绑（editor 换实例时重挂）。
    return editor.registerDecoratorListener<ReactElement>((next) => { setDecorators(next) })
  }, [editor])
  if (editor === null) return null
  const entries = Object.entries(decorators)
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([key, face]) => {
        const el = editor.getElementByKey(key)
        return el === null ? null : createPortal(face, el, key)
      })}
    </>
  )
}
