/**
 * 目录浏览弹窗的纯函数（无 React 依赖，可单测）。
 *
 * 对齐 DSH `ui-directory-picker-browse` 的目录浏览语义（同一 browse 后端：
 * `ctx.uiWorkspace.listDirectory/createDirectory`，rc.1 UiWorkspaceService），但只取核心交互所需的最小
 * 纯逻辑：home 子树面包屑折叠、隐藏条目过滤、路径编辑器的分隔符推断 /
 * 种子草稿 / 提交判定（照 DSH DirectoryBrowser 的 separatorOf 与提交语义）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/directory-browser-model
 */
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 面包屑展示行：在 home 子树内从「主目录」短链开始（对齐 DSH：链首以本地化
 * Home 标签替代主目录全路径）；子树外展示完整祖先链（根以自己的路径标注）。
 * @param listing - 当前层级的 listing（含 crumbs 祖先链 + home）。
 * @param homeLabel - 本地化「主目录」标签。
 * @returns 展示用面包屑行。
 */
export function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex((crumb: DirectoryEntry) => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/**
 * 可见条目：隐藏条目（host 标记的 dot 前缀等）默认不显示，`showHidden` 打开后显示。
 * @param entries - 一层目录条目。
 * @param showHidden - 是否显示隐藏条目。
 * @returns 过滤后的可见条目（保持原顺序）。
 */
export function visibleEntries(
  entries: readonly DirectoryEntry[],
  showHidden: boolean,
): DirectoryEntry[] {
  return entries.filter(entry => showHidden || !entry.hidden)
}

/**
 * 平台分隔符（照 DSH `separatorOf`）：由宿主主目录路径推断，绝不从用户输入
 * 或条目路径推断（反斜杠在 POSIX 上是合法名字字符）。
 * @param home - 宿主主目录路径（listing.home）。
 * @returns Windows 为 `'\\'`，其余为 `'/'`。
 */
export function separatorOf(home: string): '\\' | '/' {
  return home.includes('\\') ? '\\' : '/'
}

/**
 * 路径编辑器种子（照 DSH：打开编辑器时以「当前选中条目，否则当前层级 +
 * 尾部分隔符」起始，输入立即可续写子目录名；已带分隔符则原样保留——根路径
 * 本身就以分隔符结尾）。当前层尚未列出（如 home 列举失败）时种子为空串，
 * 让输入绝对路径成为唯一前进路径。
 * @param base - 种子基准路径（选中条目或当前层级；undefined = 无层可种子）。
 * @param home - 宿主主目录路径（分隔符推断来源）。
 * @returns 编辑态初始草稿。
 */
export function seedPathDraft(base: string | undefined, home: string): string {
  if (base === undefined) return ''
  const sep = separatorOf(home)
  return base.endsWith(sep) ? base : `${base}${sep}`
}

/**
 * 提交草稿判定（照 DSH：trim 只用于判空，Host 收到原文——真实目录名可以以
 * 空白结尾，trim 后再导航会落到它的兄弟目录）。
 * @param draft - 输入框中的路径草稿。
 * @returns 原文；全空白/空串返回 null（= 取消，不导航）。
 */
export function submittedPath(draft: string): string | null {
  return draft.trim() === '' ? null : draft
}
