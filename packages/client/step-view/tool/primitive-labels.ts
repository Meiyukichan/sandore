/**
 * primitive-labels（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/primitive-labels.ts`（只读参考 deepseek-harness）。
 * 为无 Cordis 的 UI primitives 提供本地化文案适配（diff/read/search/web 卡 chrome
 * 与 markdown）；locale 面为 sandore 命名空间（键集抄进 sandore 字典），逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/primitive-labels
 */
import type {
  DiffBlockLabels,
  MarkdownLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  WebBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

type T = TranslateNS<'sandore'>

/**
 * 构建本地化 markdown chrome 文案。
 * @param t - sandore locale seat。
 * @returns markdown chrome 文案。
 */
export function markdownLabels(t: T): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}

/**
 * 构建本地化 diff-card chrome 文案。
 * @param t - sandore locale seat。
 * @returns diff-card chrome 文案。
 */
export function diffBlockLabels(t: T): DiffBlockLabels {
  return {
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('diff.collapseAria'),
    expandAria: count => t('diff.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('diff.expandRest', { count }),
    files: count => t(count === 1 ? 'diff.files.one' : 'diff.files.other', { count }),
  }
}

/**
 * 构建本地化 read-card chrome 文案。
 * @param t - sandore locale seat。
 * @returns read-card chrome 文案。
 */
export function readBlockLabels(t: T): ReadBlockLabels {
  return {
    window: (shown, total) => t('read.window', { shown, total }),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('read.collapseAria'),
    expandAria: count => t('read.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('read.expandRest', { count }),
  }
}

/**
 * 构建本地化 search-card chrome 文案。
 * @param t - sandore locale seat。
 * @returns search-card chrome 文案。
 */
export function searchBlockLabels(t: T): SearchBlockLabels {
  return {
    pathsSummary: (shown, total, truncated) => t(
      truncated ? 'search.paths.truncated' : 'search.paths',
      { shown, total },
    ),
    matchesSummary: (shown, total, files, truncated) => t(
      truncated ? 'search.matches.truncated' : 'search.matches',
      { shown, total, files },
    ),
    copy: t('copy'),
    copied: t('copied'),
    noResults: t('search.noResults'),
    collapseAria: t('search.collapseAria'),
    expandAria: count => t('search.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('search.expandRest', { count }),
  }
}

/**
 * 构建本地化 web-card chrome 文案。
 * @param t - sandore locale seat。
 * @returns web-card chrome 文案。
 */
export function webBlockLabels(t: T): WebBlockLabels {
  return {
    noResults: t('web.noResults'),
    sourcesTruncated: t('web.sourcesTruncated'),
    http: t('web.http'),
    contentTruncated: t('web.contentTruncated'),
    markdown: markdownLabels(t),
  }
}
