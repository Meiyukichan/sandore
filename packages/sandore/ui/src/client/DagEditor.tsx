/**
 * DagEditor：两层 DAG 编排画布（React Flow + Dagre）。
 *
 * **第一层 Stage DAG**（dynamic-workflow-engine.md：仅串行 next + 并行/条件
 * branches，**无循环**）：节点 = 全部 Stage；边 = Stage 级流控（并行分支绿色、
 * 条件分支琥珀色带 expectation 标签）。点击 Stage 卡片**下钻**到该 Stage 的
 * Step DAG（面包屑返回）。
 * **第二层 Step DAG（微流程）**：节点 = 该 Stage 内的 Step；边 = 完整流控
 * （next 串行 / branches 并行+条件 / **loop.next 循环回边虚线**）。
 * 节点可拖拽、点击选中 → 右侧字段编辑面板；工具条 自动布局（dagre 分层）/缩放/适应；
 * 底部折叠 YAML 预览；保存走 `save` 回调（新建 `createDefinition`、后续 `updateYaml`）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagEditor
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, ConnectionLineType, getSmoothStepPath, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type ConnectionLineComponentProps, type Edge, type Node, type NodeProps, type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './reactflow-theme.css'
import {
  Button, CodeBlock, IconCheckOutline16, IconDownloadOutline16, IconPlayOutline16, IconPlusOutline16,
  IconSparkle16, IconTrashOutline16, Input, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DagBranch, Gates, InputFromItem, OutputToItem, WorkflowDefinition, WorkflowStage, WorkflowStep,
} from '@deepseek-ai/dsh-sandore-workflow/schema'
import type { DagRun } from '@deepseek-ai/dsh-sandore-workflow/remote'
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml'

import {
  createBlankDefinition, createCommand, createInputFromItem, createOutputToItem, createPassThroughVar,
  createStage, dagreLayout, mergedStepsOf, newId, parseOptionalNumber, stageFlowEdges, stepFlowEdges,
  trimToUndefined, withDefinitionId, wouldCreateStageCycle, type FlowEdgeKind, type MergedStep,
} from './dag-editor-model.ts'
import { CommandEditor } from './CommandEditor.tsx'
import { WorkflowDetailFields } from './DefinitionDetail.tsx'
import { FlowEditor, type FlowFields, type FlowTarget } from './FlowEditor.tsx'
import { describeSaveError, type SaveDefinition } from './sandore-save.ts'
import { describeError } from './describe-error.ts'
import type { StartInstanceParams } from './workflow-face.ts'
import { selectInstance } from './workflow-store.ts'
import css from './DagEditor.module.css'

/** DagEditor 接收的最小业务 props：初始定义 + 保存回调 + locale。 */
export interface DagEditorProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 已有定义的原始 YAML；省略时进入新建（空白骨架）。 */
  initialYaml?: string | undefined
  /** 已有定义 id；新建时省略（首次保存后由保存回调返回并回填）。 */
  initialId?: string | undefined
  /** 保存回调：`id` 为 `undefined` 时走 `createDefinition`，否则走 `updateYaml`；返回持久化后的 id。 */
  save: SaveDefinition
  /** 保存成功回调（携带持久化后的 id），供宿主刷新定义列表等。 */
  onSaved?: (id: string) => void
  /** 启动实例（「▶ 测试运行」直接以当前定义启动，无 job 概念）。 */
  startInstance(input: StartInstanceParams): Promise<DagRun>
}

/** 保存流程本地状态。 */
type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly message: string; readonly details: string | undefined }

// ── React Flow 节点数据与自定义节点 ─────────────────────────────────────────

/** Stage 节点卡尺寸（对齐官方 dagre 示例 nodeWidth 172）。 */
const STAGE_FLOW_WIDTH = 172
/** Step 节点卡尺寸（与 Stage 一致，官方示例统一 172×36）。 */
const STEP_FLOW_WIDTH = 172
const STEP_FLOW_HEIGHT = 36

/** Stage 节点 data（携带编辑态模型 + 翻译，随模型变化刷新）。 */
interface StageNodeData {
  readonly stage: WorkflowStage
  readonly t: TranslateNS<'sandore'>
  /** React Flow 要求 data 满足 `Record<string, unknown>`。 */
  readonly [key: string]: unknown
}

/** Step 节点 data。 */
interface StepNodeData {
  readonly step: WorkflowStep
  readonly t: TranslateNS<'sandore'>
  /** React Flow 要求 data 满足 `Record<string, unknown>`。 */
  readonly [key: string]: unknown
}

type StageFlowNode = Node<StageNodeData, 'stage'>
type StepFlowNode = Node<StepNodeData, 'step'>

/** Stage 节点卡（官方默认节点风格：白底居中，单行名称；垂直布局 target 上 / source 下）。 */
function StageNode({ data }: NodeProps<StageFlowNode>) {
  const { stage } = data
  return (
    <div className={css.node}>
      <Handle type="target" position={Position.Top} className={css.handle} />
      <span className={css.nodeTitle}>{stage.name}</span>
      <Handle type="source" position={Position.Bottom} className={css.handle} />
    </div>
  )
}

/** Step 节点卡（官方默认节点风格：白底居中，单行名称；垂直布局 target 上 / source 下）。 */
function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step } = data
  return (
    <div className={css.stepNode}>
      <Handle type="target" position={Position.Top} className={css.handle} />
      <span className={css.nodeTitle}>{step.name ?? step.id}</span>
      <Handle type="source" position={Position.Bottom} className={css.handle} />
    </div>
  )
}

/** 节点类型表（模块级常量，避免每次渲染重建导致 React Flow 重挂载）。 */
const nodeTypes: NodeTypes = { stage: StageNode, step: StepNode }

/** 流控边类型 → 描边样式（串行/并行分支用默认灰色实线，条件分支琥珀色虚线+期望值，循环红色虚线）。 */
function edgeStyleOf(kind: FlowEdgeKind): React.CSSProperties {
  switch (kind) {
    case 'parallel':
      return { stroke: 'var(--xy-edge-stroke-default)', strokeWidth: 2 }
    case 'conditional':
      return { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '6 4' }
    case 'loop':
      return { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '6 4' }
    default:
      return { stroke: 'var(--xy-edge-stroke-default)', strokeWidth: 2 }
  }
}

/** 跟随线（拖拽连接时的预览线）：smoothstep 路径 + 末端箭头，与边风格一致。 */
function ConnectionLineWithArrow({ fromX, fromY, toX, toY, fromPosition, toPosition, connectionLineStyle }: ConnectionLineComponentProps) {
  const [path] = getSmoothStepPath({
    sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
    targetX: toX, targetY: toY, targetPosition: toPosition,
  })
  const markerId = 'sandore-conn-arrow'
  return (
    <g>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b1b1b7" />
        </marker>
      </defs>
      <path d={path} fill="none" style={connectionLineStyle} markerEnd={`url(#${markerId})`} />
    </g>
  )
}

// ── 画布（React FlowProvider 内） ──────────────────────────────────────────

/** DagCanvas 接收的 props。 */
interface DagCanvasProps {
  /** 编辑态定义模型。 */
  definition: WorkflowDefinition
  /** 下钻目标 Stage id（undefined = Stage DAG 顶层）。 */
  drillStageId: string | undefined
  /** 选中 Stage id（Stage 层选中/下钻目标）。 */
  selectedStageId: string | undefined
  /** 选中 Step id（Step 层）。 */
  selectedStepId: string | undefined
  /** 点 Stage 节点 → 选中并下钻 Step DAG。 */
  onDrillStage(stageId: string): void
  /** 点 Step 节点（Step 层选中）。 */
  onSelectStep(stepId: string): void
  /** 点 Stage 节点（Stage 层选中，右侧面板同步）。 */
  onSelectStage(stageId: string): void
  /** 点画布空白：取消选中（Stage 层回到工作流详情 / Step 层回到空态）。 */
  onPaneClick(): void
  /** 拖拽连线（Stage 层）：source → target 设串行 next。 */
  onConnectStage(source: string, target: string): void
  /** 拖拽连线（Step 层）：source → target 设串行 next。 */
  onConnectStep(source: string, target: string): void
  /** 画布键盘删除节点（React Flow Delete/Backspace）：按层级删除并同步模型。 */
  onDeleteNodes(nodeIds: readonly string[]): void
  /** 画布键盘删除边：清掉 source 指向 target 的流控引用（next/branches/loop）。 */
  onDeleteEdges(edges: readonly { readonly source: string, readonly target: string }[]): void
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
}

/** 渲染 React Flow 画布（必须在 ReactFlowProvider 内，工具条经 useReactFlow 控制缩放）。 */
function DagCanvas({ definition, drillStageId, selectedStageId, selectedStepId, onDrillStage, onSelectStep, onSelectStage, onPaneClick, onConnectStage, onConnectStep, onDeleteNodes, onDeleteEdges, t }: DagCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow()
  // 画布视口容器：用于把「视口中心」换算成画布坐标，作为新增节点的落点。
  const canvasRef = useRef<HTMLDivElement>(null)
  // 记录上一次所在层级，用于区分「切换层级（重排）」与「同层增删（保留布局）」。
  const prevLayerRef = useRef<string | undefined>(undefined)

  const drilledStage = drillStageId === undefined
    ? undefined
    : definition.stages.find(stage => stage.id === drillStageId)

  // 节点集与边由模型派生（useMemo 避免每次渲染重算）。
  const flow = useMemo(() => {
    if (drillStageId === undefined) {
      const stageNodes: Node[] = definition.stages.map(stage => ({
        id: stage.id,
        type: 'stage',
        position: { x: 0, y: 0 },
        // 预置尺寸：React Flow v12 据此跳过 ResizeObserver 测量（避免节点 hidden 挂起）。
        width: STAGE_FLOW_WIDTH,
        height: STEP_FLOW_HEIGHT,
        data: { stage, t } as StageNodeData,
      }))
      const stageEdges: Edge[] = stageFlowEdges(definition.stages).map((edge, index) => ({
        id: `e${index}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        style: edgeStyleOf(edge.kind),
        // 仅条件分支/循环回边 animated（React Flow 的 animated 样式是流动虚线）；
        // 串行/并行分支保持实线（不 animated）。
        animated: edge.kind === 'conditional' || edge.kind === 'loop',
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeStyleOf(edge.kind).stroke as string, width: 18, height: 18 },
        ...(edge.label === undefined ? {} : { label: edge.label, labelStyle: { fill: 'var(--dsw-alias-label-caption)', fontSize: 10, fontWeight: 500 }, labelShowBg: false }),
      }))
      return { nodes: stageNodes, edges: stageEdges }
    }
    const steps = drilledStage === undefined ? [] : mergedStepsOf(definition, drilledStage)
    const stepNodes: Node[] = steps.map(step => ({
      id: step.id,
      type: 'step',
      position: { x: 0, y: 0 },
      width: STEP_FLOW_WIDTH,
      height: STEP_FLOW_HEIGHT,
      data: { step, t } as StepNodeData,
    }))
    const stepEdges: Edge[] = stepFlowEdges(steps).map((edge, index) => ({
      id: `e${index}-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      style: edgeStyleOf(edge.kind),
      // 仅条件分支/循环回边 animated（流动虚线）；串行/并行分支实线。
      animated: edge.kind === 'conditional' || edge.kind === 'loop',
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeStyleOf(edge.kind).stroke as string, width: 18, height: 18 },
      ...(edge.label === undefined ? {} : { label: edge.label, labelStyle: { fill: 'var(--dsw-alias-label-caption)', fontSize: 10, fontWeight: 500 }, labelShowBg: false }),
    }))
    return { nodes: stepNodes, edges: stepEdges }
  }, [definition, drillStageId, drilledStage, t])

  /** 把「视口中心」换算成画布坐标，作为同层新增节点的默认落点。 */
  const centerFlowPosition = (): { x: number, y: number } => {
    const el = canvasRef.current
    if (el === null) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }

  /** 在视口中心附近找一个不与现有节点重叠的空白落点（节点中心对齐视口中心）。 */
  const blankNear = (center: { x: number, y: number }, width: number, height: number, occupied: readonly Node[]): { x: number, y: number } => {
    const overlaps = (left: number, top: number): boolean => occupied.some(node => {
      const nw = node.width ?? STEP_FLOW_WIDTH
      const nh = node.height ?? STEP_FLOW_HEIGHT
      return left < node.position.x + nw && left + width > node.position.x
        && top < node.position.y + nh && top + height > node.position.y
    })
    const at = (x: number, y: number): { x: number, y: number } => ({ x: x - width / 2, y: y - height / 2 })
    if (!overlaps(center.x - width / 2, center.y - height / 2)) return at(center.x, center.y)
    // 中心被占用（如 fitView 已把节点居中在视口中心）：沿十字/对角逐圈外扩找空白。
    for (let ring = 1; ring <= 12; ring += 1) {
      const r = ring * 60
      const candidates = [
        at(center.x + r, center.y), at(center.x - r, center.y),
        at(center.x, center.y + r), at(center.x, center.y - r),
        at(center.x + r, center.y + r), at(center.x + r, center.y - r),
        at(center.x - r, center.y + r), at(center.x - r, center.y - r),
      ]
      for (const candidate of candidates) {
        if (!overlaps(candidate.x, candidate.y)) return candidate
      }
    }
    return at(center.x, center.y + 80)
  }

  // 模型变化 → 同步节点集。
  // - 首次进入 / 切换层级（drillStageId 变化）：dagre 分层布局。
  // - 同层新增节点：保留既有节点位置，仅把新节点放到「视口中心」附近的空白处（不自动连线）。
  // - 仅 data 变化（字段编辑）：保留既有拖拽位置与选中态。
  useEffect(() => {
    const specs = flow.nodes.map(node => ({
      id: node.id,
      width: node.type === 'stage' ? STAGE_FLOW_WIDTH : STEP_FLOW_WIDTH,
      height: STEP_FLOW_HEIGHT,
    }))
    const positions = dagreLayout(specs, flow.edges.map(edge => ({ source: edge.source, target: edge.target })))
    const layerChanged = prevLayerRef.current !== drillStageId
    prevLayerRef.current = drillStageId
    // 同层新增节点的落点：视口中心（只算一次）。
    const center = centerFlowPosition()
    setNodes(current => {
      const byId = new Map(current.map(node => [node.id, node] as const))
      const isFirst = current.length === 0
      return flow.nodes.map(node => {
        const existing = byId.get(node.id)
        const selected = drillStageId === undefined
          ? node.id === selectedStageId
          : node.id === selectedStepId
        if (existing !== undefined) {
          return { ...existing, data: node.data, selected }
        }
        // 新节点落点：首次加载或切换层级走 dagre；同层新增则放到视口中心附近空白处。
        const position = (isFirst || layerChanged)
          ? (positions[node.id] ?? { x: 0, y: 0 })
          : blankNear(center, node.width ?? STEP_FLOW_WIDTH, node.height ?? STEP_FLOW_HEIGHT, current)
        return { ...node, position, selected }
      })
    })
    setEdges(flow.edges)
  }, [flow, drillStageId, selectedStageId, selectedStepId, setNodes, setEdges])

  /** 自动布局：dagre 分层重排所有节点（清空拖拽覆盖）。 */
  const autoLayout = (): void => {
    const specs = flow.nodes.map(node => ({
      id: node.id,
      width: node.type === 'stage' ? STAGE_FLOW_WIDTH : STEP_FLOW_WIDTH,
      height: STEP_FLOW_HEIGHT,
    }))
    const positions = dagreLayout(specs, flow.edges.map(edge => ({ source: edge.source, target: edge.target })))
    setNodes(current => current.map(node => ({ ...node, position: positions[node.id] ?? node.position })))
  }

  return (
    <div className={css.canvasScroll} data-sandore-dag-canvas ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        // fitView 适配时限制最小 zoom，避免节点多时卡片被缩得太小。
        fitViewOptions={{ padding: 0.1, minZoom: 0.5 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
        // 连线交互：按下端口即进入连接，连线实时跟随鼠标（拖拽），拖到目标端口松手完成。
        // 关闭 connectOnClick（其「点一下点一下」不显示跟随线）；下钻/选中走 onNodeDoubleClick 双击。
        connectOnClick={false}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionRadius={30}
        // 跟随线用与边一致的默认可见灰（常量色，避免 CSS 变量在画布作用域失效导致线不可见），带末端箭头。
        connectionLineStyle={{ stroke: '#b1b1b7', strokeWidth: 2 }}
        connectionLineComponent={ConnectionLineWithArrow}
        isValidConnection={(connection) => connection.source !== connection.target && connection.source !== null && connection.target !== null}
        onConnect={(connection: Connection) => {
          if (connection.source === null || connection.target === null) return
          if (drillStageId === undefined) onConnectStage(connection.source, connection.target)
          else onConnectStep(connection.source, connection.target)
        }}
        // 键盘删除：Delete / Backspace 均可；删除同时同步模型（onNodesDelete/onEdgesDelete）。
        deleteKeyCode={['Backspace', 'Delete']}
        onNodesDelete={deleted => { onDeleteNodes(deleted.map(node => node.id)) }}
        onEdgesDelete={deleted => { onDeleteEdges(deleted.map(edge => ({ source: edge.source, target: edge.target }))) }}
        // 单击：Stage 层选中 Stage（右侧面板同步）、Step 层选中 Step；双击：Stage 下钻 / Step 选中。
        onNodeClick={(_event, node) => {
          if (node.type === 'stage') onSelectStage(node.id)
          else if (node.type === 'step') onSelectStep(node.id)
        }}
        // 点空白取消选中：Stage 层回工作流详情、Step 层回空态。
        onPaneClick={onPaneClick}
        onNodeDoubleClick={(_event, node) => {
          if (drillStageId === undefined && node.type === 'stage') {
            onDrillStage(node.id)
          } else if (node.type === 'step') {
            onSelectStep(node.id)
          }
        }}
      >
        <Background gap={20} color="var(--dsw-alias-border-l2)" />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(0, 0, 0, 0.05)"
          nodeColor={node => (node.type === 'stage' ? 'var(--dsw-alias-accent-primary)' : 'var(--dsw-alias-label-caption)')}
        />
        <Panel position="top-right" className={css.canvasToolbar}>
          <button type="button" className={css.iconBtn} title={t('editor.autoLayout')} aria-label={t('editor.autoLayout')} onClick={autoLayout}>
            🎯
          </button>
          <button type="button" className={css.iconBtn} title={t('editor.zoomIn')} aria-label={t('editor.zoomIn')} onClick={() => { zoomIn({ duration: 200 }) }}>
            ＋
          </button>
          <button type="button" className={css.iconBtn} title={t('editor.zoomOut')} aria-label={t('editor.zoomOut')} onClick={() => { zoomOut({ duration: 200 }) }}>
            －
          </button>
          <button type="button" className={css.iconBtn} title={t('editor.fit')} aria-label={t('editor.fit')} onClick={() => { void fitView({ padding: 0.25, duration: 250 }) }}>
            ⤢
          </button>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// ── 字段编辑（Step 完整字段表单，沿用既有实现） ────────────────────────────

/** 眼睛图标（预览按钮用；primitives 无眼睛图标，内联 SVG 16×16）。 */
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M8 3C4.5 3 1.8 5.4 1 8c.8 2.6 3.5 5 7 5s6.2-2.4 7-5c-.8-2.6-3.5-5-7-5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** 折叠小节标题。 */
function SectionLabel({ children }: { readonly children: string }) {
  return <div className={css.sectionLabel}>{children}</div>
}

/**
 * 输入参数条目：类型下拉（相对路径=引用 step / 正则匹配）+ 目标 step 下拉（显示名称）。
 * 简化格式：`path` 存引用的 step id（单段），不再支持 stageId.stepId。
 */
function InputRow({ item, stepOptions, onChange, onRemove, t }: {
  readonly item: InputFromItem
  readonly stepOptions: readonly FlowTarget[]
  readonly onChange: (item: InputFromItem) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  const mode: 'path' | 'regex' = item.regex !== undefined ? 'regex' : 'path'
  return (
    <div className={css.itemRow}>
      <select
        className={css.branchKindSelect}
        value={mode}
        onChange={event => {
          const next = event.target.value
          if (next === 'regex') onChange({ ...item, regex: item.regex ?? '' })
          else onChange({ ...item, regex: undefined })
        }}
      >
        <option value="path">{t('editor.field.stepName')}</option>
        <option value="regex">{t('editor.field.regex')}</option>
      </select>
      {mode === 'path' ? (
        <select
          className={css.branchTarget}
          value={item.path ?? ''}
          onChange={event => { onChange({ ...item, path: event.target.value === '' ? undefined : event.target.value }) }}
        >
          <option value="">{t('flow.none')}</option>
          {stepOptions.map(step => (
            <option key={step.id} value={step.id}>{step.name}</option>
          ))}
        </select>
      ) : (
        <Input
          className={css.branchTarget ?? ''}
          value={item.regex ?? ''}
          onChange={event => { onChange({ ...item, regex: trimToUndefined(event.target.value) }) }}
          placeholder={t('editor.field.regex')}
        />
      )}
      <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
    </div>
  )
}

/**
 * 输出参数条目：类型下拉（相对路径 / 正则匹配）+ 相对路径字符串输入。
 */
function OutputRow({ item, onChange, onRemove, t }: {
  readonly item: OutputToItem
  readonly onChange: (item: OutputToItem) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  const mode: 'path' | 'regex' = item.regex !== undefined ? 'regex' : 'path'
  return (
    <div className={css.itemRow}>
      <select
        className={css.branchKindSelect}
        value={mode}
        onChange={event => {
          const next = event.target.value
          if (next === 'regex') onChange({ ...item, regex: item.regex ?? '' })
          else onChange({ ...item, regex: undefined })
        }}
      >
        <option value="path">{t('editor.field.relativePath')}</option>
        <option value="regex">{t('editor.field.regex')}</option>
      </select>
      <Input
        className={css.branchTarget ?? ''}
        value={mode === 'path' ? (item.path ?? '') : (item.regex ?? '')}
        onChange={event => {
          const value = trimToUndefined(event.target.value)
          if (mode === 'path') onChange({ ...item, path: value })
          else onChange({ ...item, regex: value })
        }}
        placeholder={mode === 'path' ? t('editor.field.relativePath') : t('editor.field.regex')}
      />
      <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
    </div>
  )
}

/** Step 完整字段编辑器（名称 + 执行 command + 流控 FlowEditor + 映射 + gates）。 */
function StepEditor({ step, stageSteps, targets, onChange, onRemove, t }: {
  readonly step: MergedStep
  /** 当前 Stage 内全部合并 step（含 branches），用于计算回环环上节点。 */
  readonly stageSteps: readonly MergedStep[]
  readonly targets: readonly FlowTarget[]
  readonly onChange: (step: MergedStep) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  const inputFrom = step.inputFrom ?? []
  const outputTo = step.outputTo ?? []
  const passThroughVars = step.passThroughVars ?? []

  return (
    <div className={css.step}>
      <div className={css.stepHead}>
        <Input
          className={css.titleInput ?? ''}
          value={step.name ?? ''}
          onChange={event => { onChange({ ...step, name: trimToUndefined(event.target.value) }) }}
          placeholder={t('editor.step.placeholder')}
          aria-label={t('editor.step.name')}
        />
        <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
      </div>

      <SectionLabel>{t('editor.step.command')}</SectionLabel>
      {/* 命令必填：默认直接创建 shell 命令并显示编辑器（五类型 + 输入框），不做「+命令」占位。 */}
      <CommandEditor command={step.command ?? createCommand('shell')} onChange={command => { onChange({ ...step, command }) }} t={t} />

      <FlowEditor
        t={t}
        targets={targets}
        stageSteps={stageSteps}
        currentId={step.id}
        conditionTypes={['shell', 'prompt']}
        flow={{ branches: step.branches }}
        onChange={flow => {
          onChange({ ...step, branches: flow.branches as DagBranch[] })
        }}
      />

      <SectionLabel>{t('editor.section.inputFrom')}</SectionLabel>
      {inputFrom.map((item, index) => (
        <InputRow
          key={index}
          item={item}
          stepOptions={stageSteps.filter(candidate => candidate.id !== step.id).map(candidate => ({ id: candidate.id, name: candidate.name ?? candidate.id }))}
          onChange={next => { onChange({ ...step, inputFrom: inputFrom.map((current, i) => (i === index ? next : current)) }) }}
          onRemove={() => { onChange({ ...step, inputFrom: inputFrom.filter((_, i) => i !== index) }) }}
          t={t}
        />
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, inputFrom: [...inputFrom, createInputFromItem()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.outputTo')}</SectionLabel>
      {outputTo.map((item, index) => (
        <OutputRow
          key={index}
          item={item}
          onChange={next => { onChange({ ...step, outputTo: outputTo.map((current, i) => (i === index ? next : current)) }) }}
          onRemove={() => { onChange({ ...step, outputTo: outputTo.filter((_, i) => i !== index) }) }}
          t={t}
        />
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, outputTo: [...outputTo, createOutputToItem()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.passThroughVars')}</SectionLabel>
      {passThroughVars.map((variable, index) => (
        <div key={index} className={css.varRow}>
          <div className={css.varRowHead}>
            <Input className={css.varNameInput ?? ''} value={variable.name} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, name: event.target.value } : v)) }) }} placeholder={t('editor.field.name')} />
            <Button
              size="sm"
              variant={variable.refresh === true ? 'primary' : 'outline'}
              onClick={() => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, refresh: variable.refresh === true ? undefined : true } : v)) }) }}
            >
              {t('editor.field.refresh')}
            </Button>
            <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={() => { onChange({ ...step, passThroughVars: passThroughVars.filter((_, i) => i !== index) }) }} aria-label={t('editor.remove.item')} />
          </div>
          <Input value={variable.value} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, value: event.target.value } : v)) }) }} placeholder={t('editor.field.value')} />
          <Input value={variable.description} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, description: event.target.value } : v)) }) }} placeholder={t('editor.field.description')} />
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, passThroughVars: [...passThroughVars, createPassThroughVar()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.gates')}</SectionLabel>
      <GatesEditor gates={step.gates} onChange={gates => { onChange({ ...step, gates }) }} t={t} />
    </div>
  )
}

/** Stage 编辑器（名称 + 连接节点流控；Stage 层不展示 Step 简表，下钻走画布双击）。 */
function StageEditor({ stage, targets, onChange, onRemove, t }: {
  readonly stage: WorkflowStage
  readonly targets: readonly FlowTarget[]
  readonly onChange: (stage: WorkflowStage) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.step}>
      <div className={css.stepHead}>
        <Input
          className={css.titleInput ?? ''}
          value={stage.name}
          onChange={event => { onChange({ ...stage, name: event.target.value }) }}
          placeholder={t('editor.stage.placeholder')}
          aria-label={t('editor.stage.placeholder')}
        />
        <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
      </div>

      <FlowEditor
        t={t}
        targets={targets}
        conditionTypes={['shell', 'prompt']}
        flow={{ branches: stage.branches }}
        onChange={flow => {
          onChange({ ...stage, branches: flow.branches as DagBranch[] })
        }}
      />
    </div>
  )
}

/**
 * gates 编辑：引擎（finalize-manager）只消费 `primary`/`secondary` 的 enabled/prompt，
 * 且 `primary` 属工作流级（详情页配置），Step/Stage 级这里仅编辑 `secondary` 门禁
 * （enabled + prompt 审查提示词）。
 */
function GatesEditor({ gates, onChange, t }: {
  readonly gates: Gates | undefined
  readonly onChange: (gates: Gates | undefined) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const current = gates ?? {}
  const secondary = current.secondary
  return (
    <div className={css.gates}>
      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={secondary?.enabled ?? false}
          onChange={event => {
            const next = { ...current, secondary: { enabled: event.target.checked, ...(event.target.checked ? { prompt: secondary?.prompt ?? '' } : {}) } }
            onChange(next)
          }}
        />
        <span>{t('editor.field.secondaryGate')}</span>
      </label>
      {secondary?.enabled === true && (
        <Input
          value={secondary.prompt ?? ''}
          onChange={event => { onChange({ ...current, secondary: { ...secondary, prompt: trimToUndefined(event.target.value) } }) }}
          placeholder={t('editor.field.secondaryPrompt')}
        />
      )}
    </div>
  )
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

/** 渲染 DagEditor（两层 DAG 画布 + 编辑侧栏 + YAML 预览）。 */
export function DagEditor({ t, initialYaml, initialId, save, onSaved, startInstance }: DagEditorProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml))
  const [id, setId] = useState<string | undefined>(initialId)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  /** 保存成功轻提示（Toast，顶部居中临时横幅）；seq 递增供 Toast 按 key 重启动画。 */
  const [toast, setToast] = useState<{ seq: number, message: string } | undefined>(undefined)
  const [drillStageId, setDrillStageId] = useState<string | undefined>(undefined)
  // 初始不选中任何 Stage：右侧面板默认展示工作流详情（WorkflowDetailFields），
  // 点击 Stage 节点后才切换为该 Stage 的配置。
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>(undefined)
  const [previewOpen, setPreviewOpen] = useState(false)
  /** ▶ 测试运行状态：运行中禁用按钮；失败内联呈现错误。 */
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | undefined>(undefined)

  const preview = useMemo(() => serializeWorkflowYaml(definition), [definition])

  const patchStages = (patch: (stages: WorkflowStage[]) => WorkflowStage[]): void => {
    setDefinition(current => ({ ...current, stages: patch(current.stages) }))
  }

  const updateStage = (stageId: string, next: WorkflowStage): void => {
    patchStages(stages => stages.map(stage => (stage.id === stageId ? next : stage)))
  }

  /** 合并 Step 变更（V2 分离式）：定义字段写顶层 `definition.steps[id]`，流控 branches 写
   *  `stage.steps[id].branches`。两者拆分落库，保证 YAML 分离式结构。 */
  const updateStep = (stageId: string, stepId: string, next: MergedStep): void => {
    const { branches, ...definition } = next
    // 定义部分（name/command/映射/gates 等）→ 顶层 steps[]（无 id 则按 id 追加）。
    setDefinition(current => {
      const steps = current.steps ?? []
      const existing = steps.some(step => step.id === stepId)
      return { ...current, steps: existing ? steps.map(step => (step.id === stepId ? definition : step)) : [...steps, definition] }
    })
    // 流控部分（branches）→ Stage 流控位（无分支时省略字段，保持 YAML 干净）。
    patchStages(stages => stages.map(stage => (stage.id !== stageId ? stage : {
      ...stage,
      steps: stage.steps.map(step => (step.id !== stepId ? step : { id: stepId, ...(branches === undefined ? {} : { branches }) })),
    })))
  }

  /** 删除 Step（面板移除按钮 / 画布键盘删除共用）：同步清顶层定义与 Stage 流控位，
   *  并清理其余 Step 指向它的流控引用。 */
  const removeSteps = (stageId: string, ids: readonly string[]): void => {
    const removed = new Set(ids)
    setDefinition(current => ({
      ...current,
      steps: (current.steps ?? []).filter(step => !removed.has(step.id)),
    }))
    patchStages(stages => stages.map(stage => (stage.id !== stageId ? stage : {
      ...stage,
      steps: stage.steps
        .filter(step => !removed.has(step.id))
        .map(step => ({
          ...step,
          branches: (step.branches ?? [])
            .filter(branch => branch.next === undefined || !removed.has(branch.next))
            .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && removed.has(branch.loop.next)
              ? { ...branch, loop: { ...branch.loop, next: undefined } }
              : branch),
        })),
    })))
    if (selectedStepId !== undefined && removed.has(selectedStepId)) setSelectedStepId(undefined)
  }

  const removeStep = (stageId: string, stepId: string): void => {
    removeSteps(stageId, [stepId])
  }

  const addStep = (stageId: string): void => {
    const stepId = newId('step')
    // 单次状态更新：流控位（仅 id + branches）进 Stage.steps，完整定义（name/command 等）进顶层 steps[]。
    setDefinition(current => {
      const stage = current.stages.find(candidate => candidate.id === stageId)
      if (stage === undefined) return current
      const count = stage.steps.length
      // 命令必填：新 step 默认带 shell 命令（编辑器直接显示，不做「+命令」占位）。
      const definition: WorkflowStep = { id: stepId, name: `${t('editor.step.placeholder')} ${count + 1}`, command: createCommand('shell') }
      return {
        ...current,
        stages: current.stages.map(candidate => (candidate.id === stageId
          ? { ...candidate, steps: [...candidate.steps, { id: stepId }] }
          : candidate)),
        steps: [...(current.steps ?? []), definition],
      }
    })
    // 下钻态添加 step：自动选中新 step（右侧面板立即显示其配置）。
    if (drillStageId === stageId) setSelectedStepId(stepId)
  }

  const addStage = (): void => {
    const count = definition.stages.length
    const stage = createStage(`${t('editor.stage.placeholder')} ${count + 1}`)
    patchStages(stages => [...stages, stage])
    setSelectedStageId(stage.id)
    setDrillStageId(undefined)
  }

  /** 删除 Stage（面板移除按钮 / 画布键盘删除共用）：清理其余 Stage 指向它的流控引用。 */
  const removeStages = (ids: readonly string[]): void => {
    const removed = new Set(ids)
    patchStages(stages => stages
      .filter(stage => !removed.has(stage.id))
      .map(stage => ({
        ...stage,
        branches: (stage.branches ?? [])
          .filter(branch => branch.next === undefined || !removed.has(branch.next))
          .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && removed.has(branch.loop.next)
            ? { ...branch, loop: { ...branch.loop, next: undefined } }
            : branch),
      })))
    if (drillStageId !== undefined && removed.has(drillStageId)) setDrillStageId(undefined)
    if (selectedStageId !== undefined && removed.has(selectedStageId)) {
      const remaining = definition.stages.filter(stage => !removed.has(stage.id))
      setSelectedStageId(remaining[0]?.id)
    }
  }

  const removeStage = (stageId: string): void => {
    removeStages([stageId])
  }

  /** 下钻：点 Stage 节点 → 进入该 Stage 的 Step DAG（微流程），默认选中首个 Step。 */
  const drillStage = (stageId: string): void => {
    setDrillStageId(stageId)
    setSelectedStageId(stageId)
    setSelectedStepId(definition.stages.find(stage => stage.id === stageId)?.steps[0]?.id)
  }

  /** 单击选中 Stage（右侧面板同步显示该 Stage 的配置）。 */
  const selectStage = (stageId: string): void => {
    setSelectedStageId(stageId)
    setSelectedStepId(undefined)
  }

  /** 点画布空白取消选中：Stage 层回工作流详情（默认视图）、Step 层回空态。 */
  const clearSelection = (): void => {
    setSelectedStageId(undefined)
    setSelectedStepId(undefined)
  }

  const backToStages = (): void => {
    setDrillStageId(undefined)
    setSelectedStepId(undefined)
  }

  /** 连线落点：统一并入 branches。Step 层回环连线（target 为更早 step）自动附加 loop。 */
  const connectTargets = (flow: { branches?: DagBranch[] | undefined }, target: string, isBackEdge: boolean): { branches?: DagBranch[] | undefined } => {
    const branches = flow.branches ?? []
    const existing = new Set(branches.map(branch => branch.next).filter((id): id is string => id !== undefined && id !== ''))
    if (existing.has(target)) return { ...flow }
    if (isBackEdge) {
      // 回环连线：自动附加 loop（maxIterations 默认 3，next = 回边目标），loop 必填。
      return { ...flow, branches: [...branches, { next: target, loop: { maxIterations: 3, next: target } }] }
    }
    return { ...flow, branches: [...branches, { next: target }] }
  }

  /** 拖拽连线：Stage 层 source → target（统一并入并行 branches）。Stage DAG 不允许循环：回环连线被拒绝。 */
  const connectStage = (source: string, target: string): void => {
    if (wouldCreateStageCycle(definition.stages, source, target)) return
    patchStages(stages => stages.map(stage => (stage.id === source
      ? { ...stage, ...connectTargets(stage, target, false) }
      : stage)))
  }

  /** 拖拽连线：Step 层 source → target。若 target 是该 Stage 内更早的 step（数组顺序），
   *  视为回环连线：自动附加 loop（循环必填），画布以红色虚线回边展示。 */
  const connectStep = (source: string, target: string): void => {
    if (drillStageId === undefined) return
    patchStages(stages => stages.map(stage => {
      if (stage.id !== drillStageId) return stage
      const sourceIndex = stage.steps.findIndex(step => step.id === source)
      const targetIndex = stage.steps.findIndex(step => step.id === target)
      const isBackEdge = sourceIndex >= 0 && targetIndex >= 0 && targetIndex < sourceIndex
      return { ...stage, steps: stage.steps.map(step => (step.id === source
        ? { ...step, ...connectTargets(step, target, isBackEdge) }
        : step)) }
    }))
  }

  /** 画布键盘删除节点（Delete/Backspace）：按层级批量删除并同步模型。 */
  const deleteNodes = (nodeIds: readonly string[]): void => {
    if (drillStageId === undefined) removeStages(nodeIds)
    else removeSteps(drillStageId, nodeIds)
  }

  /** 画布键盘删除边：清掉 source 指向 target 的流控引用（branches[].next / branches[].loop.next）。 */
  const deleteEdges = (edges: readonly { readonly source: string, readonly target: string }[]): void => {
    if (edges.length === 0) return
    if (drillStageId === undefined) {
      patchStages(stages => stages.map(stage => {
        const targets = new Set(edges.filter(edge => edge.source === stage.id).map(edge => edge.target))
        if (targets.size === 0) return stage
        return {
          ...stage,
          branches: (stage.branches ?? [])
            .filter(branch => branch.next === undefined || !targets.has(branch.next))
            .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && targets.has(branch.loop.next)
              ? { ...branch, loop: { ...branch.loop, next: undefined } }
              : branch),
        }
      }))
    } else {
      patchStages(stages => stages.map(stage => (stage.id !== drillStageId ? stage : {
        ...stage,
        steps: stage.steps.map(step => {
          const targets = new Set(edges.filter(edge => edge.source === step.id).map(edge => edge.target))
          if (targets.size === 0) return step
          return {
            ...step,
            branches: (step.branches ?? [])
              .filter(branch => branch.next === undefined || !targets.has(branch.next))
              .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && targets.has(branch.loop.next)
                ? { ...branch, loop: { ...branch.loop, next: undefined } }
                : branch),
          }
        }),
      })))
    }
  }

  const runSave = async (): Promise<void> => {
    setSaveState({ kind: 'pending' })
    try {
      const savedId = await save(id, serializeWorkflowYaml(definition))
      setId(savedId)
      onSaved?.(savedId)
      setDefinition(current => withDefinitionId(current, savedId))
      setSaveState({ kind: 'ok' })
      // 保存成功用顶部轻提示（Toast），不占用画布上方空间。
      setToast(current => ({ seq: (current?.seq ?? 0) + 1, message: t('editor.save.success') }))
    } catch (error) {
      const { message, details } = describeSaveError(error)
      setSaveState({ kind: 'error', message, details })
    }
  }

  // Ctrl+S 保存工作流（含右侧 Step 详情面板的当前编辑态——受控组件 onChange 即时提交，
  // 保存直接序列化 definition 快照）。阻止浏览器默认「保存网页」。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void runSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  })

  // 无选中（selectedStageId === undefined）时不兜底到首个 Stage：右侧面板显示工作流详情。
  const selectedStage = definition.stages.find(stage => stage.id === selectedStageId)
  const drilledStage = drillStageId === undefined
    ? undefined
    : definition.stages.find(stage => stage.id === drillStageId)

  /** 导出 YAML：下载为 `{id}.yaml` 文件（内容与保存到后端一致）。 */
  const exportYaml = (): void => {
    const yaml = serializeWorkflowYaml(definition)
    const blob = new Blob([yaml], { type: 'application/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${id ?? definition.id ?? 'workflow'}.yaml`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  /** ▶ 测试运行：直接以当前定义启动实例（无 job 概念），成功后切执行态并选中新实例。 */
  const runTest = async (): Promise<void> => {
    const definitionId = id ?? definition.id
    if (definitionId === undefined) return
    setRunning(true)
    setRunError(undefined)
    try {
      const run = await startInstance({ workflowId: definitionId, originalInput: t('editor.testRun') })
      selectInstance(run.instanceId)
    } catch (error) {
      setRunError(describeError(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className={css.editor} aria-label={t('editor.title')} data-sandore-dag-editor>
      <header className={css.header}>
        {/* 标题 = 当前工作流名称（随右侧详情字段编辑实时更新）。 */}
        <span className={css.title} title={definition.name}>{definition.name}</span>
        <span className={css.headerActions}>
          <Button size="sm" variant="ghost" icon={<EyeIcon />} onClick={() => { setPreviewOpen(current => !current) }}>
            {t('editor.preview')}
          </Button>
          <Button size="sm" variant="ghost" icon={<IconDownloadOutline16 />} onClick={exportYaml}>
            {t('editor.export')}
          </Button>
          {/* 对话生成：静态按钮（测试左边，样式同测试/保存），待接入 AI 生成。 */}
          <Button
            size="sm"
            variant="primary"
            icon={<IconSparkle16 />}
            title={t('editor.chatCreate.hint')}
            onClick={() => { setToast(current => ({ seq: (current?.seq ?? 0) + 1, message: t('editor.chatCreate.hint') })) }}
          >
            {t('editor.chatCreate')}
          </Button>
          {/* 测试运行：置于导出右、保存左；样式与保存一致（primary 背景框）。 */}
          {id !== undefined && (
            <Button size="sm" variant="primary" icon={<IconPlayOutline16 />} disabled={running} onClick={() => { void runTest() }}>
              {t('editor.test')}
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<IconCheckOutline16 />} disabled={saveState.kind === 'pending'} onClick={() => { void runSave() }}>
            {saveState.kind === 'pending' ? t('editor.saving') : t('editor.save')}
          </Button>
        </span>
      </header>

      {saveState.kind === 'error' && (
        <p className={css.error} role="alert">
          {saveState.details === undefined
            ? t('editor.save.failed', { message: saveState.message })
            : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` })}
        </p>
      )}
      {runError !== undefined && (
        <p className={css.error} role="alert">{t('panel.error', { message: runError })}</p>
      )}

      <div className={css.canvasRow}>
        <div className={css.canvas}>
          {/* 顶部层级条：面包屑（Stage DAG 顶层 / 下钻 Stage）+ 添加动作。 */}
          <div className={css.canvasTabs}>
            {drillStageId !== undefined && (
              <button type="button" className={css.backBtn} onClick={backToStages}>
                ← {t('editor.stageDag')}
              </button>
            )}
            <span className={css.crumb}>
              {drillStageId === undefined ? t('editor.stageDag') : (drilledStage?.name ?? drillStageId)}
            </span>
            {drillStageId === undefined ? (
              <Button size="sm" variant="outline" icon={<IconPlusOutline16 />} onClick={addStage}>
                {t('editor.stage.add')}
              </Button>
            ) : drilledStage !== undefined ? (
              <Button size="sm" variant="outline" icon={<IconPlusOutline16 />} onClick={() => { addStep(drilledStage.id) }}>
                {t('editor.step.add')}
              </Button>
            ) : null}
          </div>

          <ReactFlowProvider>
            <DagCanvas
              definition={definition}
              drillStageId={drillStageId}
              selectedStageId={selectedStageId}
              selectedStepId={selectedStepId}
              onDrillStage={drillStage}
              onSelectStep={setSelectedStepId}
              onSelectStage={selectStage}
              onPaneClick={clearSelection}
              onConnectStage={connectStage}
              onConnectStep={connectStep}
              onDeleteNodes={deleteNodes}
              onDeleteEdges={deleteEdges}
              t={t}
            />
          </ReactFlowProvider>
        </div>

        {/* 右侧编辑面板：Stage 层无选中 → 工作流详情（WorkflowDetailFields）；选中 Stage →
            Stage 配置；下钻层 → 选中 Step 配置。 */}
        <aside className={css.panel} data-sandore-dag-panel>
          {drillStageId === undefined ? (
            selectedStage === undefined ? (
              <div className={css.panelBody}>
                <WorkflowDetailFields
                  t={t}
                  definition={definition}
                  onChange={next => { setDefinition(next) }}
                />
              </div>
            ) : (
              <div className={css.panelBody}>
                <StageEditor
                  stage={selectedStage}
                  targets={definition.stages
                    .filter(stage => stage.id !== selectedStage.id)
                    .filter(stage => !wouldCreateStageCycle(definition.stages, selectedStage.id, stage.id))
                    .map(stage => ({ id: stage.id, name: stage.name }))}
                  onChange={next => { updateStage(selectedStage.id, next) }}
                  onRemove={() => { removeStage(selectedStage.id) }}
                  t={t}
                />
              </div>
            )
          ) : (
            selectedStepId === undefined || drilledStage === undefined ? (
              <span className={css.panelEmpty}>{t('editor.steps.empty')}</span>
            ) : (
              (() => {
                const mergedSteps = mergedStepsOf(definition, drilledStage)
                const step = mergedSteps.find(candidate => candidate.id === selectedStepId)
                if (step === undefined) return <span className={css.panelEmpty}>{t('editor.steps.empty')}</span>
                return (
                  <div className={css.panelBody}>
                    <StepEditor
                      step={step}
                      stageSteps={mergedSteps}
                      targets={mergedSteps.filter(candidate => candidate.id !== step.id).map(candidate => ({ id: candidate.id, name: candidate.name ?? candidate.id }))}
                      onChange={next => { updateStep(drilledStage.id, step.id, next) }}
                      onRemove={() => { removeStep(drilledStage.id, step.id) }}
                      t={t}
                    />
                  </div>
                )
              })()
            )
          )}
        </aside>
      </div>

      {/* 预览弹窗：展示与保存一致的工作流 YAML（宽高放大）。 */}
      <Modal
        open={previewOpen}
        onClose={() => { setPreviewOpen(false) }}
        title={t('editor.preview')}
        closeLabel={t('overlay.close')}
        className={css.previewModal ?? ''}
        contentClassName={css.previewModalBody ?? ''}
      >
        <CodeBlock code={preview} lang="yaml" copyLabel={t('editor.preview')} />
      </Modal>

      {/* 保存成功轻提示：顶部居中临时横幅，4s 自动淡出；key=seq 使重复保存重启动画。 */}
      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.message} onDone={() => { setToast(undefined) }} />
      )}
    </section>
  )
}
