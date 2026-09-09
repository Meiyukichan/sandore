/**
 * AddNodeDialog：「+ 添加 Stage / + 添加 Step」弹窗（三级分离 plan §6.4）。
 *
 * 两个来源选项：新建空白（现状行为）/ 从库绑定（打开 LibraryPickerModal 选择）。
 * Step 新建空白沿用现状默认（Shell 命令，类型在详情面板切换），不做重复的类型选择。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/AddNodeDialog
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import css from './DagEditor.module.css'

/** 目标节点种类。 */
export type AddNodeKind = 'stage' | 'step'

/** 新建/绑定的选择结果。 */
export type AddNodeChoice = 'blank' | 'library'

/** AddNodeDialog 接收的 props。 */
export interface AddNodeDialogProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 目标节点种类。 */
  kind: AddNodeKind
  /** 关闭弹窗。 */
  onClose(): void
  /** 确认（blank = 新建空白，library = 从库绑定）。 */
  onConfirm(choice: AddNodeChoice): void
}

/** 渲染添加节点弹窗（新建空白 / 从库绑定 二选一）。 */
export function AddNodeDialog({ t, kind, onClose, onConfirm }: AddNodeDialogProps) {
  const [choice, setChoice] = useState<AddNodeChoice>('blank')
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'stage' ? t('add.stage.title') : t('add.step.title')}
      closeLabel={t('add.create.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('add.create.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => { onConfirm(choice) }}>{t('add.create.submit')}</Button>
        </>
      )}
    >
      <div className={css.addNodeDialog}>
        <label className={css.addNodeOption}>
          <input
            type="radio"
            name="sandore-add-node-choice"
            checked={choice === 'blank'}
            onChange={() => { setChoice('blank') }}
          />
          <span className={css.addNodeOptionBody}>
            <span className={css.addNodeOptionTitle}>{t('add.create.blank')}</span>
            {kind === 'step' && <span className={css.addNodeOptionHint}>{t('add.create.stepBlank.hint')}</span>}
          </span>
        </label>
        <label className={css.addNodeOption}>
          <input
            type="radio"
            name="sandore-add-node-choice"
            checked={choice === 'library'}
            onChange={() => { setChoice('library') }}
          />
          <span className={css.addNodeOptionBody}>
            <span className={css.addNodeOptionTitle}>{t('add.create.fromLibrary')}</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}
