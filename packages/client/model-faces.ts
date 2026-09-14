/**
 * composer 选择器的运行时注入面（模型目录 / 会话权限投影 / 命令执行）。
 *
 * 编译期不依赖 DSH 的 ui-model-selection / ui-permission-presets 包（沙盒仓库
 * 未链接它们），这里按 harness 的 wire 形状自声明最小类型；运行时复用 dev 实例
 * 已加载的 `ctx.modelDirectories` 服务、会话 projections 与 `remote.commands`，
 * 行为与 DSH 主 session 的模型/权限选择完全一致（同一数据源、同一 RPC）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/model-faces
 */

/** 可订阅快照面（对齐 runtime 的 `ObservableSnapshot`）。 */
export interface ObservableFace<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

// ── 模型目录（对齐 apiproxy sessions.ts 的 wire 形状） ────────────────────

/** 一个会话的完整模型选择。 */
export interface ModelSelection {
  /** 注册的 provider 路由。 */
  provider: string
  /** provider 属下的模型 id。 */
  model: string
  /** 推理等级（缺省保留 provider/adapter 默认）。 */
  reasoningEffort?: string
}

/** adapter 属下的一个推理等级。 */
export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

/** 单个精确模型路由的可选推理元数据。 */
export interface ModelReasoning {
  efforts: ModelReasoningEffort[]
  defaultEffort?: string
}

/** provider 组内展示的一个模型。 */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

/** 一个成功广告了模型的 provider 组。 */
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** 目录加载失败的 provider。 */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** 模型目录快照（对齐 ui-model-selection 的 `ModelDirectoryState`）。 */
export interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** 单个会话的共享模型目录控制面（对齐 `ModelDirectory`）。 */
export interface ModelDirectoryFace {
  readonly store: ObservableFace<ModelDirectoryState>
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<void>
  dispose(): void
}

// ── 会话权限投影（对齐 dsh-permission-presets 的 `PermissionSelect`） ───────

/**
 * 宿主 `ctx.modelDirectories` 目录（ui-model-selection `ModelDirectory`）的最小
 * 运行时面（编译期不依赖该包，结构 cast）。
 */
interface HostModelDirectoryLike {
  store: ObservableFace<ModelDirectoryState>
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<unknown>
  dispose(): void
}

/** 模型目录不可用时的占位目录（不崩渲染；load/select 报可读错误）。
 *  快照必须是**引用稳定**的闭包单例：`useSyncExternalStore` 要求 `getSnapshot`
 *  返回缓存值，否则 React 判定 store 每次都在变 → 「Maximum update depth exceeded」
 *  （React #185，seat 崩溃会关掉整个 conversation column）。`routable: false`
 *  让 ModelSelectSandore 直接渲染 null（隐藏选择器），而不是渲染一个错误触发器。 */
function unavailableModelDirectory(reason: string | (() => string)): ModelDirectoryFace {
  const reasonOf = typeof reason === 'function' ? reason : (): string => reason
  /** 读取时现算（引用稳定的**对象**，但 error 文案随最后一次失败原因更新——诊断用）。 */
  const snapshotOf = (): ModelDirectoryState => ({
    current: null, routable: false, groups: [], failures: [],
    status: 'error', error: reasonOf(),
  })
  // 引用稳定性：只在失败原因变化时换对象（稳态下 uSES 看到的是同一个引用）。
  let cached = snapshotOf()
  const current = (): ModelDirectoryState => {
    if (cached.error !== reasonOf()) cached = snapshotOf()
    return cached
  }
  return {
    store: {
      getSnapshot: current,
      subscribe: () => () => {},
    },
    async load(): Promise<never> { throw new Error(reasonOf()) },
    async select(): Promise<never> { throw new Error(reasonOf()) },
    dispose(): void {},
  }
}

/**
 * 把宿主 `ctx.modelDirectories.directoryFor(sessionId)` 的目录桥接为沙盒
 * `ModelDirectoryFace`（运行时结构 cast，无编译期依赖）。
 *
 * 自愈语义（client B）：宿主服务/会话可晚于组件挂载出现（scope 未就绪时
 * `directoryFor` 抛错）——`hostResolver` 支持函数形式（每次现取服务）；解析失败期间
 * `getSnapshot()` 返回**引用稳定**的占位快照（routable:false 隐藏选择器，防 React
 * #185），并在每次读取时重试解析（成功后固定 host 目录、转发其 store/操作）。
 *
 * @param hostResolver - 含 `modelDirectories` 的对象，或每次现取该对象的函数
 *   （函数形式支持服务晚到自愈）。
 * @param sessionId - 目标会话 id。
 */
export function bridgeModelDirectory(
  hostResolver: unknown | (() => unknown),
  sessionId: string,
): ModelDirectoryFace {
  // cordis 服务属性守卫：未注入声明时属性访问会抛「cannot get … without inject」，
  // 需 try/catch 防御（宿主未加载 ui-model-selection 时同样落占位目录）。
  const readHost = (): { modelDirectories?: { directoryFor(sid: string): unknown } } | undefined => {
    try {
      const value = typeof hostResolver === 'function' ? (hostResolver as () => unknown)() : hostResolver
      return value as { modelDirectories?: { directoryFor(sid: string): unknown } } | undefined
    } catch {
      return undefined
    }
  }
  let directory: HostModelDirectoryLike | undefined
  // 失败原因（诊断用：区分「宿主没装 ui-model-selection」与「directoryFor 抛错」——
  // 两者的 UI 表现都是隐藏触发器，没有这条线索 e2e 只能看到「席位是空的」）。
  let failure = 'model selection is unavailable (ui-model-selection not loaded)'
  const tryResolve = (): void => {
    if (directory !== undefined) return
    try {
      const resolver = readHost()
      if (resolver?.modelDirectories === undefined) {
        failure = 'model selection is unavailable (ctx.modelDirectories is not resolvable)'
        directory = undefined
        return
      }
      const raw = resolver.modelDirectories.directoryFor(sessionId)
      directory = raw === undefined ? undefined : raw as HostModelDirectoryLike
      if (directory === undefined) failure = `model selection is unavailable (no directory for session ${sessionId})`
    } catch (error) {
      failure = `model selection is unavailable (directoryFor threw: ${error instanceof Error ? error.message : String(error)})`
      directory = undefined
    }
  }
  const resolved = (): ModelDirectoryFace | undefined => {
    tryResolve()
    if (directory === undefined) return undefined
    return {
      store: directory.store,
      load: () => directory!.load().then(() => undefined),
      select: selection => directory!.select(selection).then(() => undefined),
      dispose: () => directory!.dispose(),
    }
  }
  // 宿主立即可用：直通 host 目录（store 引用不变，旧调用方/测试语义保持）。
  const immediate = resolved()
  if (immediate !== undefined) return immediate
  // 宿主未就绪：返回自愈占位——getSnapshot 每次重试解析（会话/服务晚出现后自动恢复），
  // 未就绪期间快照引用稳定（占位单例缓存；错误文案随最后一次失败原因更新）。
  const unavailable = unavailableModelDirectory(() => failure)
  return {
    store: {
      getSnapshot: () => resolved()?.store.getSnapshot() ?? unavailable.store.getSnapshot(),
      subscribe: (fn) => {
        const live = resolved()
        return live === undefined ? () => {} : live.store.subscribe(fn)
      },
    },
    load: async () => {
      const live = resolved()
      return live === undefined ? unavailable.load() : live.load()
    },
    select: async (selection) => {
      const live = resolved()
      return live === undefined ? unavailable.select(selection) : live.select(selection)
    },
    dispose: () => {
      resolved()?.dispose()
    },
  }
}

/** 权限模式选项。 */
export interface PermissionOption {
  value: string
  name: string
  description?: string
}

/** 权限选择投影值（`projections.permissions`）。 */
export interface PermissionSelectValue {
  options: PermissionOption[]
  currentValue: string
}

// ── 会话命令执行（对齐 runtime `remote.commands.execute`） ────────────────

/** `remote.commands.execute` 的最小返回面。 */
export interface CommandExecuteResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/**
 * 解析 `/permission`（无参）命令报告文本：
 * `current preset workspace-write (available: workspace-write, danger-full-access)`。
 * 权限投影缺失时作为回退数据源（与 DSH 主 session 的权限选择同一命令路径）。
 */
export function parsePermissionReport(text: string): PermissionSelectValue | undefined {
  const match = /^current preset (\S+) \(available: ([^)]+)\)$/.exec(text.trim())
  if (match === null) return undefined
  const currentValue = match[1]!
  const options = match[2]!.split(',').map(part => part.trim()).filter(part => part !== '').map(name => ({ value: name, name }))
  if (options.length === 0) return undefined
  return { options, currentValue }
}
