/**
 * 工具卡 chrome labels 构造器（对齐 DSH `ui-tool/src/client/tool/models/primitive-labels.ts`）。
 *
 * 上游把 block 组件的本地化文案（复制/折叠/摘要等）从组件内硬编码改为调用方经
 * `labels` 必填 prop 传入；本文件为 sandore 各渲染位（ToolRow 展开体等）按
 * `TranslateNS<'sandore'>` 构建这些 labels，文案键见 locales.ts。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/tool/primitive-labels
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

/** 构建 Markdown chrome labels（复制按钮 + 脚注区标题）。 */
export function markdownLabels(t: T): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}

/** 构建 diff 卡 chrome labels（复制/折叠/文件数）。 */
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

/** 构建 read 卡 chrome labels（窗口计数/复制/折叠）。 */
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

/** 构建 search 卡 chrome labels（路径/匹配摘要/无结果/折叠）。 */
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

/** 构建 web 卡 chrome labels（无结果/截断提示/HTTP + markdown chrome）。 */
export function webBlockLabels(t: T): WebBlockLabels {
  return {
    noResults: t('web.noResults'),
    sourcesTruncated: t('web.sourcesTruncated'),
    http: t('web.http'),
    contentTruncated: t('web.contentTruncated'),
    markdown: markdownLabels(t),
  }
}