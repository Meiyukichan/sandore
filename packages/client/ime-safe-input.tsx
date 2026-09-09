/**
 * 带 IME（中文输入法）composition 守卫的受控输入组件。
 *
 * 详情/字段面板的受控输入框曾在组合期间被 onChange 值变换（`trimToUndefined` 等）
 * 与受控回写中断，导致中文无法输入（plan §6.5 修复项 2）。守卫策略：
 * - `onCompositionStart` → 进入组合态，输入进本地缓冲（DOM 原生维护组合文本，
 *   React 受控 value 不回写）；
 * - 组合期间的 `onChange` 只更新缓冲，**不向模型提交**；
 * - `onCompositionEnd` → 退出组合态，一次性提交最终文本。
 * 非组合态行为与普通受控输入一致。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/ime-safe-input
 */
import { useState } from 'react'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'

import css from './DagEditor.module.css'

/** 组合态管理 + 展示值/提交回调的共享逻辑（input/textarea 复用）。 */
function useCompositionGuard(
  value: string,
  onCommit: (value: string) => void,
): {
  display: string
  onCompositionStart: () => void
  onCompositionEnd: (event: { currentTarget: { value: string } }) => void
  onChange: (event: { target: { value: string } }) => void
} {
  // 组合态用 ref（同步判定，避免组合期间 setState 触发的额外渲染路径）。
  const [composing, setComposing] = useState(false)
  const [buffer, setBuffer] = useState<string | null>(null)
  return {
    display: composing ? (buffer ?? value) : value,
    onCompositionStart: () => { setComposing(true) },
    onCompositionEnd: (event) => {
      setComposing(false)
      setBuffer(null)
      onCommit(event.currentTarget.value)
    },
    onChange: (event) => {
      const next = event.target.value
      if (composing) {
        // 组合中：仅缓冲，不提交（模型保持组合前的值，不受拼音中间态影响）。
        setBuffer(next)
        return
      }
      onCommit(next)
    },
  }
}

/** ImeSafeInput 的 props：受控 `value` + 提交回调；其余 input 属性透传 DSH Input。 */
export interface ImeSafeInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd' | 'className'> {
  value: string
  onCommit(value: string): void
  /** wrapper 类名（undefined 视为空串，对齐 DSH Input 的 clsx 合并）。 */
  className?: string | undefined
}

/** 渲染带 composition 守卫的受控文本输入（封装 DSH `Input`，样式/图标能力不变）。 */
export function ImeSafeInput({ value, onCommit, className, ...rest }: ImeSafeInputProps) {
  const guard = useCompositionGuard(value, onCommit)
  return (
    <Input
      {...rest}
      className={className ?? ''}
      value={guard.display}
      onCompositionStart={guard.onCompositionStart}
      onCompositionEnd={guard.onCompositionEnd}
      onChange={guard.onChange}
    />
  )
}

/** ImeSafeTextarea 的 props：受控 `value` + 提交回调；其余 textarea 属性透传。 */
export interface ImeSafeTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'> {
  value: string
  onCommit(value: string): void
}

/** 渲染带 composition 守卫的受控多行文本域（plan §6.5 修复项 3：提示词大段输入）。 */
export function ImeSafeTextarea({ value, onCommit, className, ...rest }: ImeSafeTextareaProps) {
  const guard = useCompositionGuard(value, onCommit)
  return (
    <textarea
      {...rest}
      className={className === undefined ? css.promptTextarea : `${css.promptTextarea} ${className}`}
      value={guard.display}
      onCompositionStart={guard.onCompositionStart}
      onCompositionEnd={guard.onCompositionEnd}
      onChange={guard.onChange}
    />
  )
}
