/**
 * 内存 mock storageDomain（测试专用，非发布面）。
 *
 * 用 `Map` 实现 `KvTable` 的等价语义（读同步、写 await、`delete` 幂等、
 * `update` 缺 key 抛 `missing-key`），并提供 `open(spec)`/`get(name)` 的
 * `DomainFacility` 形状，供 `persistence.spec.ts` / `remote.spec.ts` 以
 * `ctx.provide('storageDomain', …)` 注入，避免在单元测试中拉起真实后端。
 * @module dsh-sandore/workflow/tests/mocks/storage-domain
 */
import { DomainError, type Domain, type DomainSpec, type KvTable } from '@deepseek-ai/dsh-storage-domain'

/** Map 版 `KvTable`：`K` 为记录键，`V` 为记录值。 */
export class MemoryKvTable<K extends string, V> implements KvTable<K, V> {
  private readonly records = new Map<K, V>()

  get(key: K): V | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.records.entries()
  }

  keys(): IterableIterator<K> {
    return this.records.keys()
  }

  get size(): number {
    return this.records.size
  }

  async put(key: K, value: V): Promise<void> {
    this.records.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) {
      throw new DomainError('missing-key', `key '${String(key)}' is missing`)
    }
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

/** 单个已打开域的内存实现：按 spec 声明的表名建空表，`close()` 幂等。 */
export class MemoryDomain {
  readonly name: string

  private readonly tableMap = new Map<string, MemoryKvTable<string, unknown>>()
  private isClosed = false

  constructor(name: string, tableNames: readonly string[]) {
    this.name = name
    for (const tableName of tableNames) {
      this.tableMap.set(tableName, new MemoryKvTable())
    }
  }

  table<K extends string, V>(name: string): KvTable<K, V> {
    const table = this.tableMap.get(name)
    if (table === undefined) {
      throw new Error(`memory domain '${this.name}' has no table '${name}'`)
    }
    return table as unknown as KvTable<K, V>
  }

  async close(): Promise<void> {
    this.isClosed = true
  }

  get closed(): boolean {
    return this.isClosed
  }
}

/** 内存 `DomainFacility` 形状：`open` 建域（拒绝重复打开），`get` 供断言诊断。 */
export class MemoryStorageDomain {
  private readonly domains = new Map<string, MemoryDomain>()

  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    const name = spec.name
    const existing = this.domains.get(name)
    if (existing !== undefined && !existing.closed) {
      throw new DomainError('already-open', `domain '${name}' is already open`)
    }
    const domain = new MemoryDomain(name, Object.keys(spec.tables))
    this.domains.set(name, domain)
    // 测试 mock：MemoryDomain 是 Domain<S> 的等价实现（spec 未声明 global，句柄为 never）。
    return domain as unknown as Domain<S>
  }

  get(name: string): MemoryDomain | undefined {
    return this.domains.get(name)
  }
}
