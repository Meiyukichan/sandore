/**
 * image-attachment：沙盒面板的本地图片附件面。
 *
 * DSH 的 `ImageAttachmentRef` 定义在 `@deepseek-ai/dsh-attachment`（runtime 的
 * `ISession.readAttachment` 返回它），sandore 面板不声明该依赖，故按
 * `packages/attachment/attachment/src/types.ts` 的字段结构本地复刻（仅类型，无行为）。
 * `resolveImage` 抄自 DSH `ui-conversation/src/client/service.ts` 的
 * `ConversationController.resolveImage`：经 `session.readAttachment` 取回字节，构建
 * blob URL（不可用时退化为 data URL），按 session+attachmentId 缓存。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/attachment/image-attachment
 */
import type { SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Raster image formats accepted by the version-one attachment path. */
export type SandoreImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object（dsh-attachment 的 ImageAttachmentRef 结构复刻）。 */
export interface SandoreImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: string
  /** Media type verified from the stored bytes. */
  mediaType: SandoreImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

interface PendingImage {
  readonly generation: number
  readonly pending: Promise<string>
}

/**
 * 构建一个会话授权的历史图片 URL 加载器（`(attachment) => Promise<string>`）。
 * 行为与 DSH `ConversationController.resolveImage` 一致：按 session+attachmentId 缓存，
 * 取回字节后优先 blob URL（`URL.createObjectURL` 不可用时退化为 base64 data URL）。
 * 调用方应在卸载时 `dispose()` 释放创建的 blob URL。
 * @param session - 所属会话面（readAttachment 授权源）。
 * @returns `{ load, dispose }`：load 为加载器；dispose 释放缓存与已创建 URL。
 */
export function createImageLoader(session: SessionFace): {
  load(attachment: SandoreImageAttachmentRef): Promise<string>
  dispose(): void
} {
  const sessionId = session.sessionId as SessionId
  const generation = 0
  const imageUrls = new Map<string, PendingImage>()
  const createdImageUrls = new Set<string>()
  const revokePreview = (url: string): void => {
    createdImageUrls.delete(url)
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  }
  return {
    load(attachment: SandoreImageAttachmentRef): Promise<string> {
      const key = `${sessionId}:${attachment.attachmentId}`
      const cached = imageUrls.get(key)
      if (cached !== undefined) return cached.pending
      // readAttachment 的参数为 runtime 的 branded AttachmentId（dsh-api-remotes）；
      // 本地结构复刻的 attachmentId 为 string，经参数类型转换（值本身不变）。
      const attachmentId = attachment.attachmentId as unknown as Parameters<SessionFace['readAttachment']>[0]
      const pending = session.readAttachment(attachmentId)
        .then((result) => {
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (typeof URL.createObjectURL !== 'function') {
            return `data:${attachment.mediaType};base64,${bytesToBase64(Uint8Array.from(result.value.data))}`
          }
          const bytes = Uint8Array.from(result.value.data)
          const url = URL.createObjectURL(new Blob([bytes.buffer], { type: attachment.mediaType }))
          createdImageUrls.add(url)
          return url
        })
        .catch((error: unknown) => {
          if (imageUrls.get(key)?.generation === generation) imageUrls.delete(key)
          throw error
        })
      imageUrls.set(key, { generation, pending })
      return pending
    },
    dispose(): void {
      imageUrls.clear()
      for (const url of [...createdImageUrls]) revokePreview(url)
    },
  }
}
