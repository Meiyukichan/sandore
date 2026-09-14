/**
 * composer-trigger-menu.spec：step 面板触发词菜单的**纯逻辑 + 控制器解析**回归。
 *
 * 覆盖：
 * - 行模型（`stepComposerMenuRowsOf`）逐条对齐 DSH MenuView 的渲染规则：空 ready 组整组
 *   不渲染、分组标题与 section 标题的互斥、pending 骨架、highlight→active；
 * - 面包屑通道（`stepComposerMenuCrumbNavsOf`）与可见性（`stepComposerMenuVisible`）；
 * - 候选行 DOM id（`stepComposerMenuOptionId`，与 DSH `optionId()` 逐字一致）；
 * - 单例解析（`stepComposerTriggerOf`）的全部降级阶梯：未安装 / 无 scope / scope 抛错 /
 *   scope 未物化 / 服务缺失 / sessionOf 抛错 / 控制器形状不符 —— 一律 undefined **不抛**；
 * - install/clear 生命周期（后装覆盖前装、旧 disposer 不误清新装）。
 *
 * 渲染与键路（↑↓/Enter/Esc/空格、指针 hover/pick）在 composer-trigger-menu-render.spec
 * （jsdom）里覆盖。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-trigger-menu.spec
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearStepComposerTriggers,
  installStepComposerTriggers,
  stepComposerMenuCrumbNavsOf,
  stepComposerMenuOptionId,
  stepComposerMenuRowsOf,
  stepComposerMenuTitleOf,
  stepComposerMenuVisible,
  stepComposerTriggerOf,
  type StepComposerMenuStateLike,
  type StepComposerTriggerControllerLike,
} from './composer-trigger-menu.ts'

afterEach(() => {
  clearStepComposerTriggers()
  vi.restoreAllMocks()
})

/** 一条候选（step 组默认带 section，模拟 @step source 的真实产出）。 */
function item(name: string, section: string | undefined = undefined) {
  return {
    name,
    description: `${name} · 已完成`,
    icon: 'session' as const,
    value: `{"instanceId":"i1","stepId":"${name}"}`,
    ...(section === undefined ? {} : { section }),
  }
}

/** 菜单快照桩。 */
function state(partial: Partial<StepComposerMenuStateLike> = {}): StepComposerMenuStateLike {
  return { open: true, groups: [], highlight: null, ...partial }
}

describe('stepComposerMenuOptionId', () => {
  it('spells the DSH MenuView option id verbatim', () => {
    expect(stepComposerMenuOptionId('step', 0)).toBe('dsh-slash-option-step-0')
    expect(stepComposerMenuOptionId('reference', 12)).toBe('dsh-slash-option-reference-12')
  })
})

describe('stepComposerMenuRowsOf（行模型，对齐 DSH MenuView）', () => {
  it('renders one section title per section run and suppresses the group title when items carry sections', () => {
    const rows = stepComposerMenuRowsOf(state({
      groups: [{
        source: 'step',
        showGroupTitle: true,
        status: 'ready',
        items: [item('构建'), item('测试'), item('构建', '其它')],
      }],
    }))
    // 无分组标题（item 带 section）；section 变化处才出标题：'步骤' 只在第 0 行出。
    expect(rows.map(row => row.kind)).toEqual(['option', 'option', 'option'])
    const options = rows.filter(row => row.kind === 'option')
    expect(options.map(row => row.sectionTitle)).toEqual([undefined, undefined, '其它'])
    expect(options.map(row => row.id)).toEqual([
      'dsh-slash-option-step-0',
      'dsh-slash-option-step-1',
      'dsh-slash-option-step-2',
    ])
  })

  it('uses the given step section label for the first section row', () => {
    const rows = stepComposerMenuRowsOf(state({
      groups: [{ source: 'step', status: 'ready', items: [item('构建', '步骤')] }],
    }))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.kind).toBe('option')
    expect(row?.kind === 'option' ? row.sectionTitle : undefined).toBe('步骤')
  })

  it('renders a group title for section-less sources and honours showGroupTitle: false', () => {
    const titled = stepComposerMenuRowsOf(state({
      groups: [{ source: 'skill', status: 'ready', items: [item('code-review', undefined)] }],
    }), source => (source === 'skill' ? '技能' : source))
    expect(titled.map(row => row.kind)).toEqual(['group-title', 'option'])
    expect(titled[0]?.kind === 'group-title' ? titled[0].label : undefined).toBe('技能')

    const untitled = stepComposerMenuRowsOf(state({
      groups: [{ source: 'reference', showGroupTitle: false, status: 'ready', items: [item('a.md')] }],
    }))
    expect(untitled.map(row => row.kind)).toEqual(['option'])
  })

  it('drops an empty ready group entirely and shows skeletons only while pending', () => {
    const rows = stepComposerMenuRowsOf(state({
      groups: [
        { source: 'empty', status: 'ready', items: [] },
        { source: 'loading', status: 'pending', items: [] },
        { source: 'step', status: 'ready', items: [item('构建', '步骤')] },
      ],
    }), source => source.toUpperCase())
    expect(rows.map(row => row.kind)).toEqual(['group-title', 'skeleton', 'option'])
    expect(rows[0]?.kind === 'group-title' ? rows[0].label : undefined).toBe('LOADING')
    expect(rows[1]?.kind === 'skeleton' ? rows[1].source : undefined).toBe('loading')
  })

  it('marks exactly the highlighted row active (keyboard and pointer share one highlight)', () => {
    const rows = stepComposerMenuRowsOf(state({
      groups: [
        { source: 'reference', status: 'ready', items: [item('a.md')] },
        { source: 'step', status: 'ready', items: [item('构建'), item('测试')] },
      ],
      highlight: { source: 'step', index: 1 },
    }))
    const actives = rows
      .filter(row => row.kind === 'option')
      .map(row => (row.kind === 'option' ? row.active : false))
    expect(actives).toEqual([false, false, true])
  })

  it('keeps the previous rows of a pending refinement (DSH retains them across a query change)', () => {
    const rows = stepComposerMenuRowsOf(state({
      groups: [{ source: 'step', status: 'pending', items: [item('构建', '步骤')] }],
    }))
    expect(rows.map(row => row.kind)).toEqual(['option'])
  })
})

describe('stepComposerMenuCrumbNavsOf / stepComposerMenuVisible', () => {
  it('publishes one nav per source with a non-empty trail, in group order', () => {
    const navs = stepComposerMenuCrumbNavsOf(state({
      groups: [
        { source: 'reference', status: 'ready', items: [item('x.md')] },
        { source: 'step', status: 'ready', items: [item('构建')] },
      ],
    }), new Map([
      ['reference', [{ label: 'src', value: 'src' }, { label: 'lib', value: 'src/lib', current: true }]],
      ['ghost', [{ label: 'x', value: 'x' }]],
    ]))
    expect(navs).toHaveLength(1)
    expect(navs[0]?.source).toBe('reference')
    expect(navs[0]?.crumbs.map(crumb => crumb.current === true)).toEqual([false, true])
  })

  it('is invisible when closed, and when every group is an empty ready group', () => {
    expect(stepComposerMenuVisible(state({ open: false }))).toBe(false)
    expect(stepComposerMenuVisible(state({ groups: [{ source: 'empty', status: 'ready', items: [] }] }))).toBe(false)
    expect(stepComposerMenuVisible(state({ groups: [{ source: 'step', status: 'ready', items: [item('构建')] }] }))).toBe(true)
    // 只有面包屑（无候选行）也算有内容。
    expect(stepComposerMenuVisible(
      state({ groups: [{ source: 'reference', status: 'ready', items: [] }] }),
      new Map([['reference', [{ label: 'src', value: 'src' }]]]),
    )).toBe(true)
  })
})

// ── 单例解析：全部降级阶梯 ──────────────────────────────────────────────────

/** 可观察面桩。 */
function storeOf<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of [...listeners]) listener() },
  }
}

/** 控制器桩（只实现本模块消费的公开面）。 */
function controllerStub() {
  const calls = { pick: [] as Array<[string, number, string | undefined]>, hover: [] as Array<[string, number]>, dismiss: 0, crumb: [] as Array<[string, number]> }
  return {
    calls,
    menu: storeOf<StepComposerMenuStateLike>(state()),
    pick: (source: string, index: number, action?: string) => { calls.pick.push([source, index, action]) },
    hover: (source: string, index: number) => { calls.hover.push([source, index]) },
    pickCrumb: (source: string, index: number) => { calls.crumb.push([source, index]) },
    dismiss: () => { calls.dismiss += 1 },
  }
}

/** 安装一份可用的依赖（返回可改写的探针）。 */
function installWith(controller: unknown, options: { scope?: unknown; registry?: unknown; throwInSessionOf?: boolean } = {}) {
  const scopes: string[] = []
  const installed = installStepComposerTriggers({
    sessions: {
      scope: (id: string) => {
        scopes.push(id)
        return 'scope' in options ? options.scope : { id }
      },
    },
    inputTriggers: () => ('registry' in options
      ? options.registry as never
      : {
        sessionOf: () => {
          if (options.throwInSessionOf === true) throw new Error('conversation.input.for requires a session scope')
          return controller
        },
      }),
  })
  return { scopes, installed }
}

describe('stepComposerTriggerOf（控制器解析与降级）', () => {
  it('degrades to undefined before any install', () => {
    expect(stepComposerTriggerOf('child-1')).toBeUndefined()
  })

  it('resolves the scoped controller and forwards pick/hover/pickCrumb/dismiss with arguments', () => {
    const stub = controllerStub()
    const { scopes } = installWith(stub)
    const controller = stepComposerTriggerOf('child-1')
    expect(controller).toBeDefined()
    expect(scopes).toEqual(['child-1'])
    controller?.pick('step', 2)
    controller?.pick('step', 3, 'drill')
    controller?.hover('step', 1)
    controller?.pickCrumb('reference', 0)
    controller?.dismiss()
    expect(stub.calls.pick).toEqual([['step', 2, undefined], ['step', 3, 'drill']])
    expect(stub.calls.hover).toEqual([['step', 1]])
    expect(stub.calls.crumb).toEqual([['reference', 0]])
    expect(stub.calls.dismiss).toBe(1)
    // 菜单面透传同一个 store（React 侧 useSyncExternalStore 依赖身份稳定）。
    expect(controller?.menu.getSnapshot()).toBe(stub.menu.getSnapshot())
  })

  it('degrades on an empty/absent session id, disabled or missing services, and unresolvable scopes', () => {
    const stub = controllerStub()
    installWith(stub)
    expect(stepComposerTriggerOf(undefined)).toBeUndefined()
    expect(stepComposerTriggerOf('')).toBeUndefined()

    // scope 未物化（返回 undefined）→ 降级（作用域晚出现是常态）。
    installWith(stub, { scope: undefined })
    expect(stepComposerTriggerOf('child-2')).toBeUndefined()

    // 宿主未装 ui-input-trigger → 降级。
    installWith(stub, { registry: undefined })
    expect(stepComposerTriggerOf('child-3')).toBeUndefined()

    // sessions 缺失 → 降级。
    installStepComposerTriggers({ sessions: undefined, inputTriggers: () => ({ sessionOf: () => stub }) })
    expect(stepComposerTriggerOf('child-4')).toBeUndefined()
  })

  it('degrades without throwing when sessionOf refuses the scope or the shape is wrong', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    installWith(controllerStub(), { throwInSessionOf: true })
    expect(stepComposerTriggerOf('child-5')).toBeUndefined()
    expect(error).toHaveBeenCalled()

    // 形状不符：menu 不可观察 / 动作缺失 → 降级（不把半个控制器交给渲染层）。
    for (const malformed of [
      undefined,
      null,
      {},
      { menu: { getSnapshot: () => state() } },
      { menu: storeOf(state()) },
      { menu: storeOf(state()), pick: () => {}, hover: () => {} },
      { menu: storeOf(state()), pick: () => {}, hover: () => {}, dismiss: 'nope' },
    ]) {
      installWith(malformed)
      expect(stepComposerTriggerOf('child-6')).toBeUndefined()
    }

    // scope() 自身抛错（作用域寻址时序）同样降级。
    installStepComposerTriggers({
      sessions: { scope: () => { throw new Error('no such session scope') } },
      inputTriggers: () => ({ sessionOf: () => controllerStub() }),
    })
    expect(stepComposerTriggerOf('child-7')).toBeUndefined()
  })

  it('keeps the newest install when an older disposer runs late (HMR ordering)', () => {
    const first = controllerStub()
    const second = controllerStub()
    const a = installWith(first)
    const b = installWith(second)
    a.installed()
    expect(stepComposerTriggerOf('child-8')).toBeDefined()
    b.installed()
    expect(stepComposerTriggerOf('child-8')).toBeUndefined()
    expect(stepComposerMenuTitleOf('skill')).toBe('skill')
  })

  it('translates group titles through the injected menuTitle, falling back to the raw source name', () => {
    installStepComposerTriggers({
      sessions: { scope: () => ({}) },
      inputTriggers: () => ({ sessionOf: () => controllerStub() }),
      menuTitle: (source: string) => (source === 'skill' ? '技能' : ''),
    })
    expect(stepComposerMenuTitleOf('skill')).toBe('技能')
    // 空串（DSH 未注册键回原名）与未知 source 都回原名。
    expect(stepComposerMenuTitleOf('ghost')).toBe('ghost')
  })
})

/** 类型自检：导出的控制器面与渲染组件消费的结构一致（改签名时编译期即报错）。 */
const _typecheck: (controller: StepComposerTriggerControllerLike) => void = controller => {
  void controller.menu.getSnapshot()
  void controller.pick
}
void _typecheck
