/** 展开的 WorkflowPanel 占位：header（编排 toggle + 新增）+ 三态列表 + ping 往返验证。 */

import { useState } from 'react'
import { Button, IconPlusOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostCall, PingResponse } from './host.ts'
import { isPingResponse } from './host.ts'
import type { SandoreKey } from './locales.ts'
import css from './WorkflowPanel.module.css'

/** 面板接收的最小业务 face。 */
export interface WorkflowPanelProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** Client→Host RPC 桥。 */
  host: HostCall
}

/** 三态列表占位行。 */
interface PlaceholderRow {
  readonly id: string
  readonly name: string
  readonly state: StateDotState
  readonly statusKey: SandoreKey
}

/** 占位三态列表：就绪 / 运行中 / 已完成。 */
const PLACEHOLDER_ROWS: readonly PlaceholderRow[] = [
  { id: 'sandore-ready', name: 'sample-workflow-ready', state: 'warning', statusKey: 'panel.state.ready' },
  { id: 'sandore-running', name: 'sample-workflow-running', state: 'ongoing', statusKey: 'panel.state.running' },
  { id: 'sandore-done', name: 'sample-workflow-done', state: 'done', statusKey: 'panel.state.completed' },
]

/** ping 往返的本地状态。 */
type PingState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ok'; readonly response: PingResponse }
  | { readonly kind: 'error'; readonly message: string }

/** 渲染 WorkflowPanel 占位。 */
export function WorkflowPanel({ t, host }: WorkflowPanelProps) {
  const [orchestrating, setOrchestrating] = useState(false)
  const [ping, setPing] = useState<PingState>({ kind: 'idle' })

  const runPing = async (): Promise<void> => {
    setPing({ kind: 'pending' })
    try {
      const result: unknown = await host.call('sandore.ping')
      if (isPingResponse(result)) {
        setPing({ kind: 'ok', response: result })
      } else {
        setPing({ kind: 'error', message: 'unexpected response shape' })
      }
    } catch (error) {
      setPing({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <section className={css.panel} aria-label={t('panel.title')} data-sandore-panel>
      <header className={css.header}>
        <span className={css.title}>{t('panel.title')}</span>
        <label className={css.orchestrate}>
          <input
            type="checkbox"
            checked={orchestrating}
            onChange={(event) => { setOrchestrating(event.target.checked) }}
          />
          <span>{t('panel.orchestrate')}</span>
        </label>
        <Button size="sm" variant="primary" icon={<IconPlusOutline16 />}>
          {t('panel.add')}
        </Button>
      </header>
      <div className={css.body}>
        <h3 className={css.group}>{t('panel.list.heading')}</h3>
        <ul className={css.rows}>
          {PLACEHOLDER_ROWS.map((row) => (
            <li key={row.id} className={css.row}>
              <StateDot state={row.state} />
              <span className={css.rowName}>{row.name}</span>
              <span className={css.rowStatus}>{t(row.statusKey)}</span>
            </li>
          ))}
        </ul>
        <div className={css.ping}>
          <Button size="sm" variant="outline" onClick={() => { void runPing() }} disabled={ping.kind === 'pending'}>
            {ping.kind === 'pending' ? t('panel.ping.loading') : t('panel.ping')}
          </Button>
          {ping.kind === 'ok' && (
            <pre className={css.pingResult}>{JSON.stringify(ping.response)}</pre>
          )}
          {ping.kind === 'error' && (
            <p className={css.pingError} role="alert">{t('panel.ping.failed', { message: ping.message })}</p>
          )}
        </div>
      </div>
    </section>
  )
}
