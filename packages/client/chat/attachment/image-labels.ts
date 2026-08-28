/**
 * image-labels：抄自 DSH `packages/client/ui-attachment/src/client/labels.ts`（消息图片
 * 部分；drop/rail 标签不属于聊天面板）。把 sandore 命名空间的 image.* 键解析为
 * MessageImage/ImageLightbox 的标签面。逐字保留逻辑。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/attachment/image-labels
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageLightboxLabels } from './ImageLightbox.tsx'
import type { MessageImageLabels } from './MessageImage.tsx'

/**
 * Resolve original-image lightbox strings from the sandore namespace.
 * @param t - sandore namespace translator.
 * @returns translated lightbox labels.
 */
export function lightboxLabels(t: TranslateNS<'sandore'>): ImageLightboxLabels {
  return { dialog: t('image.preview'), close: t('image.closePreview') }
}

/**
 * Resolve historical message-image strings from the sandore namespace.
 * @param t - sandore namespace translator.
 * @returns translated message-image labels.
 */
export function messageImageLabels(t: TranslateNS<'sandore'>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: lightboxLabels(t),
  }
}
