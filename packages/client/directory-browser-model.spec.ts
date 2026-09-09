/**
 * directory-browser-model.ts 的纯函数单元测试：home 子树面包屑折叠、隐藏条目
 * 过滤、路径编辑器的分隔符推断 / 种子草稿 / 提交判定。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/directory-browser-model.spec
 */
import { describe, expect, it } from 'vitest'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'

import { displayCrumbs, seedPathDraft, separatorOf, submittedPath, visibleEntries } from './directory-browser-model.ts'

/** 构造一个 listing（crumbs 祖先链 + home + 当前路径 + 条目）。 */
function listing(crumbs: { name: string; path: string }[], home: string, path: string, entries: { name: string; path: string; hidden: boolean }[]): DirectoryListing {
  return {
    home,
    path,
    crumbs: crumbs.map(crumb => ({ name: crumb.name, path: crumb.path, hidden: false })),
    entries: entries.map(entry => ({ name: entry.name, path: entry.path, hidden: entry.hidden })),
  }
}

describe('displayCrumbs', () => {
  it('collapses the home subtree into a localized Home crumb', () => {
    const home = '/home/u'
    const l = listing(
      [
        { name: '/', path: '/' },
        { name: 'home', path: '/home' },
        { name: 'u', path: '/home/u' },
        { name: 'proj', path: '/home/u/proj' },
      ],
      home,
      '/home/u/proj',
      [],
    )

    expect(displayCrumbs(l, '主目录')).toEqual([
      { name: '主目录', path: '/home/u', hidden: false },
      { name: 'proj', path: '/home/u/proj', hidden: false },
    ])
  })

  it('keeps the full ancestry when outside the home subtree', () => {
    const home = '/home/u'
    const l = listing(
      [
        { name: '/', path: '/' },
        { name: 'mnt', path: '/mnt' },
        { name: 'data', path: '/mnt/data' },
      ],
      home,
      '/mnt/data',
      [],
    )

    expect(displayCrumbs(l, '主目录')).toEqual([
      { name: '/', path: '/', hidden: false },
      { name: 'mnt', path: '/mnt', hidden: false },
      { name: 'data', path: '/mnt/data', hidden: false },
    ])
  })

  it('labels the filesystem root by its own path when navigating to /', () => {
    const home = '/home/u'
    const l = listing([{ name: '/', path: '/' }], home, '/', [])

    expect(displayCrumbs(l, '主目录')).toEqual([
      { name: '/', path: '/', hidden: false },
    ])
  })
})

describe('separatorOf', () => {
  it('detects the Windows separator from the home path', () => {
    expect(separatorOf('C:\\Users\\u')).toBe('\\')
  })

  it('defaults to the POSIX separator elsewhere', () => {
    expect(separatorOf('/home/u')).toBe('/')
    expect(separatorOf('')).toBe('/')
  })
})

describe('seedPathDraft', () => {
  it('seeds from the current selection with a trailing separator', () => {
    expect(seedPathDraft('/home/u/proj', '/home/u')).toBe('/home/u/proj/')
  })

  it('keeps a trailing separator that is already there (root included)', () => {
    expect(seedPathDraft('/', '/home/u')).toBe('/')
    expect(seedPathDraft('C:\\Users\\u\\', 'C:\\Users\\u')).toBe('C:\\Users\\u\\')
  })

  it('seeds empty when nothing is listed (the recovery path)', () => {
    expect(seedPathDraft(undefined, '/home/u')).toBe('')
  })
})

describe('submittedPath', () => {
  it('hands the typed path to the host verbatim (Enter 提交)', () => {
    expect(submittedPath('/')).toBe('/')
    expect(submittedPath('/mnt/data')).toBe('/mnt/data')
  })

  it('cancels a blank draft instead of navigating', () => {
    expect(submittedPath('')).toBeNull()
    expect(submittedPath('   ')).toBeNull()
  })
})

describe('visibleEntries', () => {
  const entries = [
    { name: 'app', path: '/p/app', hidden: false },
    { name: '.git', path: '/p/.git', hidden: true },
    { name: 'node_modules', path: '/p/node_modules', hidden: false },
  ]

  it('hides hidden entries by default', () => {
    expect(visibleEntries(entries, false).map(entry => entry.name)).toEqual(['app', 'node_modules'])
  })

  it('reveals hidden entries when toggled', () => {
    expect(visibleEntries(entries, true)).toHaveLength(3)
  })
})
