/**
 * PreviewPanel：执行态右栏文件/结果预览（默认隐藏，树形导航叶子点击后出现）。
 *
 * result 叶子显示 Step 输出全文（MarkdownText 渲染，与时间线/DAG 视图一致）；artifact 叶子显示文件路径
 * 元信息（产物无内容读取 RPC，正文即路径集合）。关闭按钮隐藏右栏并清选中态。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/PreviewPanel
 */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { PreviewTarget } from './workflow-store.ts'
import css from './preview.module.css'

/** PreviewPanel 接收的 props。 */
export interface PreviewPanelProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 预览目标（null = 关闭/隐藏）。 */
  target: PreviewTarget | null
  /** 关闭预览。 */
  onClose(): void
}

/** 渲染右栏预览。 */
export function PreviewPanel({ t, target, onClose }: PreviewPanelProps) {
  if (target === null) return null
  return (
    <div className={css.root} data-sandore-preview>
      <header className={css.header}>
        <span className={css.title}>{target.name}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.close}
          aria-label={t('run.preview.close')}
          title={t('run.preview.close')}
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className={css.body}>
        <div className={css.meta}>
          <span>{target.kind === 'result' ? '📝' : '📄'} {target.kind === 'result' ? t('run.result') : t('run.artifact')}</span>
          {target.meta !== undefined && <span>{target.meta}</span>}
        </div>
        {target.text !== undefined && (
          target.kind === 'result'
            ? <div className={css.text}><MarkdownText text={target.text} /></div>
            : <pre className={css.file}>{target.text}</pre>
        )}
      </div>
    </div>
  )
}
