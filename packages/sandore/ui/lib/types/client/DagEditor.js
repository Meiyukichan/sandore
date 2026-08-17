import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, ConnectionLineType, getSmoothStepPath, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './reactflow-theme.css';
import { Button, CodeBlock, DisclosureRow, IconChevronRightOutline14, IconPlusOutline16, IconTrashOutline16, Input, } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml';
import { createBlankDefinition, createCommand, createInputFromItem, createOutputToItem, createPassThroughVar, createStage, dagreLayout, newId, stageFlowEdges, stepFlowEdges, trimToUndefined, withDefinitionId, wouldCreateStageCycle, } from "./dag-editor-model.js";
import { CommandEditor } from "./CommandEditor.js";
import { FlowEditor } from "./FlowEditor.js";
import { describeSaveError } from "./sandore-save.js";
import css from './DagEditor.module.css';
// ── React Flow 节点数据与自定义节点 ─────────────────────────────────────────
/** Stage 节点卡尺寸（对齐官方 dagre 示例 nodeWidth 172）。 */
const STAGE_FLOW_WIDTH = 172;
/** Step 节点卡尺寸（与 Stage 一致，官方示例统一 172×36）。 */
const STEP_FLOW_WIDTH = 172;
const STEP_FLOW_HEIGHT = 36;
/** Stage 节点卡（官方默认节点风格：白底居中，单行名称；垂直布局 target 上 / source 下）。 */
function StageNode({ data }) {
    const { stage } = data;
    return (_jsxs("div", { className: css.node, children: [_jsx(Handle, { type: "target", position: Position.Top, className: css.handle }), _jsx("span", { className: css.nodeTitle, children: stage.name }), _jsx(Handle, { type: "source", position: Position.Bottom, className: css.handle })] }));
}
/** Step 节点卡（官方默认节点风格：白底居中，单行名称；垂直布局 target 上 / source 下）。 */
function StepNode({ data }) {
    const { step } = data;
    return (_jsxs("div", { className: css.stepNode, children: [_jsx(Handle, { type: "target", position: Position.Top, className: css.handle }), _jsx("span", { className: css.nodeTitle, children: step.name ?? step.id }), _jsx(Handle, { type: "source", position: Position.Bottom, className: css.handle })] }));
}
/** 节点类型表（模块级常量，避免每次渲染重建导致 React Flow 重挂载）。 */
const nodeTypes = { stage: StageNode, step: StepNode };
/** 流控边类型 → 描边样式（串行/并行分支用默认灰色实线，条件分支琥珀色虚线+期望值，循环红色虚线）。 */
function edgeStyleOf(kind) {
    switch (kind) {
        case 'parallel':
            return { stroke: 'var(--xy-edge-stroke-default)', strokeWidth: 2 };
        case 'conditional':
            return { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '6 4' };
        case 'loop':
            return { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '6 4' };
        default:
            return { stroke: 'var(--xy-edge-stroke-default)', strokeWidth: 2 };
    }
}
/** 跟随线（拖拽连接时的预览线）：smoothstep 路径 + 末端箭头，与边风格一致。 */
function ConnectionLineWithArrow({ fromX, fromY, toX, toY, fromPosition, toPosition, connectionLineStyle }) {
    const [path] = getSmoothStepPath({
        sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
        targetX: toX, targetY: toY, targetPosition: toPosition,
    });
    const markerId = 'sandore-conn-arrow';
    return (_jsxs("g", { children: [_jsx("defs", { children: _jsx("marker", { id: markerId, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", children: _jsx("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#b1b1b7" }) }) }), _jsx("path", { d: path, fill: "none", style: connectionLineStyle, markerEnd: `url(#${markerId})` })] }));
}
/** 渲染 React Flow 画布（必须在 ReactFlowProvider 内，工具条经 useReactFlow 控制缩放）。 */
function DagCanvas({ definition, drillStageId, selectedStageId, selectedStepId, onDrillStage, onSelectStep, onSelectStage, onConnectStage, onConnectStep, onDeleteNodes, onDeleteEdges, t }) {
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow();
    // 画布视口容器：用于把「视口中心」换算成画布坐标，作为新增节点的落点。
    const canvasRef = useRef(null);
    // 记录上一次所在层级，用于区分「切换层级（重排）」与「同层增删（保留布局）」。
    const prevLayerRef = useRef(undefined);
    const drilledStage = drillStageId === undefined
        ? undefined
        : definition.stages.find(stage => stage.id === drillStageId);
    // 节点集与边由模型派生（useMemo 避免每次渲染重算）。
    const flow = useMemo(() => {
        if (drillStageId === undefined) {
            const stageNodes = definition.stages.map(stage => ({
                id: stage.id,
                type: 'stage',
                position: { x: 0, y: 0 },
                // 预置尺寸：React Flow v12 据此跳过 ResizeObserver 测量（避免节点 hidden 挂起）。
                width: STAGE_FLOW_WIDTH,
                height: STEP_FLOW_HEIGHT,
                data: { stage, t },
            }));
            const stageEdges = stageFlowEdges(definition.stages).map((edge, index) => ({
                id: `e${index}-${edge.source}-${edge.target}`,
                source: edge.source,
                target: edge.target,
                type: 'smoothstep',
                style: edgeStyleOf(edge.kind),
                // 仅条件分支/循环回边 animated（React Flow 的 animated 样式是流动虚线）；
                // 串行/并行分支保持实线（不 animated）。
                animated: edge.kind === 'conditional' || edge.kind === 'loop',
                markerEnd: { type: MarkerType.ArrowClosed, color: edgeStyleOf(edge.kind).stroke, width: 18, height: 18 },
                ...(edge.label === undefined ? {} : { label: edge.label, labelStyle: { fill: 'var(--dsw-alias-label-caption)', fontSize: 10, fontWeight: 500 }, labelShowBg: false }),
            }));
            return { nodes: stageNodes, edges: stageEdges };
        }
        const steps = drilledStage?.steps ?? [];
        const stepNodes = steps.map(step => ({
            id: step.id,
            type: 'step',
            position: { x: 0, y: 0 },
            width: STEP_FLOW_WIDTH,
            height: STEP_FLOW_HEIGHT,
            data: { step, t },
        }));
        const stepEdges = stepFlowEdges(steps).map((edge, index) => ({
            id: `e${index}-${edge.source}-${edge.target}`,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            style: edgeStyleOf(edge.kind),
            // 仅条件分支/循环回边 animated（流动虚线）；串行/并行分支实线。
            animated: edge.kind === 'conditional' || edge.kind === 'loop',
            markerEnd: { type: MarkerType.ArrowClosed, color: edgeStyleOf(edge.kind).stroke, width: 18, height: 18 },
            ...(edge.label === undefined ? {} : { label: edge.label, labelStyle: { fill: 'var(--dsw-alias-label-caption)', fontSize: 10, fontWeight: 500 }, labelShowBg: false }),
        }));
        return { nodes: stepNodes, edges: stepEdges };
    }, [definition, drillStageId, drilledStage, t]);
    /** 把「视口中心」换算成画布坐标，作为同层新增节点的默认落点。 */
    const centerFlowPosition = () => {
        const el = canvasRef.current;
        if (el === null)
            return { x: 0, y: 0 };
        const rect = el.getBoundingClientRect();
        return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    };
    /** 在视口中心附近找一个不与现有节点重叠的空白落点（节点中心对齐视口中心）。 */
    const blankNear = (center, width, height, occupied) => {
        const overlaps = (left, top) => occupied.some(node => {
            const nw = node.width ?? STEP_FLOW_WIDTH;
            const nh = node.height ?? STEP_FLOW_HEIGHT;
            return left < node.position.x + nw && left + width > node.position.x
                && top < node.position.y + nh && top + height > node.position.y;
        });
        const at = (x, y) => ({ x: x - width / 2, y: y - height / 2 });
        if (!overlaps(center.x - width / 2, center.y - height / 2))
            return at(center.x, center.y);
        // 中心被占用（如 fitView 已把节点居中在视口中心）：沿十字/对角逐圈外扩找空白。
        for (let ring = 1; ring <= 12; ring += 1) {
            const r = ring * 60;
            const candidates = [
                at(center.x + r, center.y), at(center.x - r, center.y),
                at(center.x, center.y + r), at(center.x, center.y - r),
                at(center.x + r, center.y + r), at(center.x + r, center.y - r),
                at(center.x - r, center.y + r), at(center.x - r, center.y - r),
            ];
            for (const candidate of candidates) {
                if (!overlaps(candidate.x, candidate.y))
                    return candidate;
            }
        }
        return at(center.x, center.y + 80);
    };
    // 模型变化 → 同步节点集。
    // - 首次进入 / 切换层级（drillStageId 变化）：dagre 分层布局。
    // - 同层新增节点：保留既有节点位置，仅把新节点放到「视口中心」附近的空白处（不自动连线）。
    // - 仅 data 变化（字段编辑）：保留既有拖拽位置与选中态。
    useEffect(() => {
        const specs = flow.nodes.map(node => ({
            id: node.id,
            width: node.type === 'stage' ? STAGE_FLOW_WIDTH : STEP_FLOW_WIDTH,
            height: STEP_FLOW_HEIGHT,
        }));
        const positions = dagreLayout(specs, flow.edges.map(edge => ({ source: edge.source, target: edge.target })));
        const layerChanged = prevLayerRef.current !== drillStageId;
        prevLayerRef.current = drillStageId;
        // 同层新增节点的落点：视口中心（只算一次）。
        const center = centerFlowPosition();
        setNodes(current => {
            const byId = new Map(current.map(node => [node.id, node]));
            const isFirst = current.length === 0;
            return flow.nodes.map(node => {
                const existing = byId.get(node.id);
                const selected = drillStageId === undefined
                    ? node.id === selectedStageId
                    : node.id === selectedStepId;
                if (existing !== undefined) {
                    return { ...existing, data: node.data, selected };
                }
                // 新节点落点：首次加载或切换层级走 dagre；同层新增则放到视口中心附近空白处。
                const position = (isFirst || layerChanged)
                    ? (positions[node.id] ?? { x: 0, y: 0 })
                    : blankNear(center, node.width ?? STEP_FLOW_WIDTH, node.height ?? STEP_FLOW_HEIGHT, current);
                return { ...node, position, selected };
            });
        });
        setEdges(flow.edges);
    }, [flow, drillStageId, selectedStageId, selectedStepId, setNodes, setEdges]);
    /** 自动布局：dagre 分层重排所有节点（清空拖拽覆盖）。 */
    const autoLayout = () => {
        const specs = flow.nodes.map(node => ({
            id: node.id,
            width: node.type === 'stage' ? STAGE_FLOW_WIDTH : STEP_FLOW_WIDTH,
            height: STEP_FLOW_HEIGHT,
        }));
        const positions = dagreLayout(specs, flow.edges.map(edge => ({ source: edge.source, target: edge.target })));
        setNodes(current => current.map(node => ({ ...node, position: positions[node.id] ?? node.position })));
    };
    return (_jsx("div", { className: css.canvasScroll, "data-sandore-dag-canvas": true, ref: canvasRef, children: _jsxs(ReactFlow, { nodes: nodes, edges: edges, onNodesChange: onNodesChange, onEdgesChange: onEdgesChange, nodeTypes: nodeTypes, fitView: true, 
            // fitView 适配时限制最小 zoom，避免节点多时卡片被缩得太小。
            fitViewOptions: { padding: 0.1, minZoom: 0.5 }, minZoom: 0.2, maxZoom: 2, proOptions: { hideAttribution: true }, colorMode: "system", 
            // 连线交互：按下端口即进入连接，连线实时跟随鼠标（拖拽），拖到目标端口松手完成。
            // 关闭 connectOnClick（其「点一下点一下」不显示跟随线）；下钻/选中走 onNodeDoubleClick 双击。
            connectOnClick: false, connectionLineType: ConnectionLineType.SmoothStep, connectionRadius: 30, 
            // 跟随线用与边一致的默认可见灰（常量色，避免 CSS 变量在画布作用域失效导致线不可见），带末端箭头。
            connectionLineStyle: { stroke: '#b1b1b7', strokeWidth: 2 }, connectionLineComponent: ConnectionLineWithArrow, isValidConnection: (connection) => connection.source !== connection.target && connection.source !== null && connection.target !== null, onConnect: (connection) => {
                if (connection.source === null || connection.target === null)
                    return;
                if (drillStageId === undefined)
                    onConnectStage(connection.source, connection.target);
                else
                    onConnectStep(connection.source, connection.target);
            }, 
            // 键盘删除：Delete / Backspace 均可；删除同时同步模型（onNodesDelete/onEdgesDelete）。
            deleteKeyCode: ['Backspace', 'Delete'], onNodesDelete: deleted => { onDeleteNodes(deleted.map(node => node.id)); }, onEdgesDelete: deleted => { onDeleteEdges(deleted.map(edge => ({ source: edge.source, target: edge.target }))); }, 
            // 单击：Stage 层选中 Stage（右侧面板同步）、Step 层选中 Step；双击：Stage 下钻 / Step 选中。
            onNodeClick: (_event, node) => {
                if (node.type === 'stage')
                    onSelectStage(node.id);
                else if (node.type === 'step')
                    onSelectStep(node.id);
            }, onNodeDoubleClick: (_event, node) => {
                if (drillStageId === undefined && node.type === 'stage') {
                    onDrillStage(node.id);
                }
                else if (node.type === 'step') {
                    onSelectStep(node.id);
                }
            }, children: [_jsx(Background, { gap: 20, color: "var(--dsw-alias-border-l2)" }), _jsx(MiniMap, { pannable: true, zoomable: true, maskColor: "rgba(0, 0, 0, 0.05)", nodeColor: node => (node.type === 'stage' ? 'var(--dsw-alias-accent-primary)' : 'var(--dsw-alias-label-caption)') }), _jsxs(Panel, { position: "top-right", className: css.canvasToolbar, children: [_jsx("button", { type: "button", className: css.iconBtn, title: t('editor.autoLayout'), "aria-label": t('editor.autoLayout'), onClick: autoLayout, children: "\uD83C\uDFAF" }), _jsx("button", { type: "button", className: css.iconBtn, title: t('editor.zoomIn'), "aria-label": t('editor.zoomIn'), onClick: () => { zoomIn({ duration: 200 }); }, children: "\uFF0B" }), _jsx("button", { type: "button", className: css.iconBtn, title: t('editor.zoomOut'), "aria-label": t('editor.zoomOut'), onClick: () => { zoomOut({ duration: 200 }); }, children: "\uFF0D" }), _jsx("button", { type: "button", className: css.iconBtn, title: t('editor.fit'), "aria-label": t('editor.fit'), onClick: () => { void fitView({ padding: 0.25, duration: 250 }); }, children: "\u2922" })] })] }) }));
}
// ── 字段编辑（Step 完整字段表单，沿用既有实现） ────────────────────────────
/** 折叠小节标题。 */
function SectionLabel({ children }) {
    return _jsx("div", { className: css.sectionLabel, children: children });
}
/** 单个映射条目（inputFrom/outputTo 的 `{id, path, regex}`）编辑行。 */
function MappingRow({ item, onChange, onRemove, t }) {
    return (_jsxs("div", { className: css.itemRow, children: [_jsx(Input, { value: item.id, onChange: event => { onChange({ ...item, id: event.target.value }); }, placeholder: t('editor.field.id') }), _jsx(Input, { value: item.path ?? '', onChange: event => { onChange({ ...item, path: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.path') }), _jsx(Input, { value: item.regex ?? '', onChange: event => { onChange({ ...item, regex: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.regex') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemove, "aria-label": t('editor.remove.item') })] }));
}
/** Step 完整字段编辑器（名称 + 执行 command + 流控 FlowEditor + 映射 + gates）。 */
function StepEditor({ step, targets, onChange, onRemove, t }) {
    const inputFrom = step.inputFrom ?? [];
    const outputTo = step.outputTo ?? [];
    const passThroughVars = step.passThroughVars ?? [];
    return (_jsxs("div", { className: css.step, children: [_jsxs("div", { className: css.stepHead, children: [_jsx(Input, { className: css.titleInput ?? '', value: step.name ?? '', onChange: event => { onChange({ ...step, name: trimToUndefined(event.target.value) }); }, placeholder: t('editor.step.placeholder'), "aria-label": t('editor.step.name') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemove, "aria-label": t('editor.remove.item') })] }), _jsx(SectionLabel, { children: t('editor.step.command') }), _jsx(CommandEditor, { command: step.command ?? createCommand('shell'), onChange: command => { onChange({ ...step, command }); }, t: t }), _jsx(FlowEditor, { t: t, targets: targets, conditionTypes: ['shell', 'prompt'], flow: { branches: step.branches }, onChange: flow => {
                    onChange({ ...step, branches: flow.branches });
                } }), _jsx(SectionLabel, { children: t('editor.section.inputFrom') }), inputFrom.map((item, index) => (_jsx(MappingRow, { item: item, onChange: next => { onChange({ ...step, inputFrom: inputFrom.map((current, i) => (i === index ? next : current)) }); }, onRemove: () => { onChange({ ...step, inputFrom: inputFrom.filter((_, i) => i !== index) }); }, t: t }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, inputFrom: [...inputFrom, createInputFromItem()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.outputTo') }), outputTo.map((item, index) => (_jsx(MappingRow, { item: item, onChange: next => { onChange({ ...step, outputTo: outputTo.map((current, i) => (i === index ? next : current)) }); }, onRemove: () => { onChange({ ...step, outputTo: outputTo.filter((_, i) => i !== index) }); }, t: t }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, outputTo: [...outputTo, createOutputToItem()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.passThroughVars') }), passThroughVars.map((variable, index) => (_jsxs("div", { className: css.varRow, children: [_jsxs("div", { className: css.varRowHead, children: [_jsx(Input, { className: css.varNameInput ?? '', value: variable.name, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, name: event.target.value } : v)) }); }, placeholder: t('editor.field.name') }), _jsx(Button, { size: "sm", variant: variable.refresh === true ? 'primary' : 'outline', onClick: () => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, refresh: variable.refresh === true ? undefined : true } : v)) }); }, children: t('editor.field.refresh') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: () => { onChange({ ...step, passThroughVars: passThroughVars.filter((_, i) => i !== index) }); }, "aria-label": t('editor.remove.item') })] }), _jsx(Input, { value: variable.value, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, value: event.target.value } : v)) }); }, placeholder: t('editor.field.value') }), _jsx(Input, { value: variable.description, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, description: event.target.value } : v)) }); }, placeholder: t('editor.field.description') })] }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, passThroughVars: [...passThroughVars, createPassThroughVar()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.gates') }), _jsx(GatesEditor, { gates: step.gates, onChange: gates => { onChange({ ...step, gates }); }, t: t })] }));
}
/** Stage 编辑器（名称 + 连接节点流控；Stage 层不展示 Step 简表，下钻走画布双击）。 */
function StageEditor({ stage, targets, onChange, onRemove, t }) {
    return (_jsxs("div", { className: css.step, children: [_jsxs("div", { className: css.stepHead, children: [_jsx(Input, { className: css.titleInput ?? '', value: stage.name, onChange: event => { onChange({ ...stage, name: event.target.value }); }, placeholder: t('editor.stage.placeholder'), "aria-label": t('editor.stage.placeholder') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemove, "aria-label": t('editor.remove.item') })] }), _jsx(FlowEditor, { t: t, targets: targets, conditionTypes: ['shell', 'prompt'], flow: { branches: stage.branches }, onChange: flow => {
                    onChange({ ...stage, branches: flow.branches });
                } })] }));
}
/**
 * gates 编辑：引擎（finalize-manager）只消费 `primary`/`secondary` 的 enabled/prompt，
 * 且 `primary` 属工作流级（详情页配置），Step/Stage 级这里仅编辑 `secondary` 门禁
 * （enabled + prompt 审查提示词）。
 */
function GatesEditor({ gates, onChange, t }) {
    const current = gates ?? {};
    const secondary = current.secondary;
    return (_jsxs("div", { className: css.gates, children: [_jsxs("label", { className: css.checkbox, children: [_jsx("input", { type: "checkbox", checked: secondary?.enabled ?? false, onChange: event => {
                            const next = { ...current, secondary: { enabled: event.target.checked, ...(event.target.checked ? { prompt: secondary?.prompt ?? '' } : {}) } };
                            onChange(next);
                        } }), _jsx("span", { children: t('editor.field.secondaryGate') })] }), secondary?.enabled === true && (_jsx(Input, { value: secondary.prompt ?? '', onChange: event => { onChange({ ...current, secondary: { ...secondary, prompt: trimToUndefined(event.target.value) } }); }, placeholder: t('editor.field.secondaryPrompt') }))] }));
}
// ── 主组件 ─────────────────────────────────────────────────────────────────
/** 渲染 DagEditor（两层 DAG 画布 + 编辑侧栏 + YAML 预览）。 */
export function DagEditor({ t, initialYaml, initialId, save, onSaved }) {
    const [definition, setDefinition] = useState(() => initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml));
    const [id, setId] = useState(initialId);
    const [saveState, setSaveState] = useState({ kind: 'idle' });
    const [drillStageId, setDrillStageId] = useState(undefined);
    const [selectedStageId, setSelectedStageId] = useState(definition.stages[0]?.id);
    const [selectedStepId, setSelectedStepId] = useState(undefined);
    const [previewOpen, setPreviewOpen] = useState(false);
    const preview = useMemo(() => serializeWorkflowYaml(definition), [definition]);
    const patchStages = (patch) => {
        setDefinition(current => ({ ...current, stages: patch(current.stages) }));
    };
    const updateStage = (stageId, next) => {
        patchStages(stages => stages.map(stage => (stage.id === stageId ? next : stage)));
    };
    const updateStep = (stageId, stepId, next) => {
        patchStages(stages => stages.map(stage => (stage.id === stageId
            ? { ...stage, steps: stage.steps.map(step => (step.id === stepId ? next : step)) }
            : stage)));
    };
    /** 删除 Step（面板移除按钮 / 画布键盘删除共用）：清理其余 Step 指向它的流控引用。 */
    const removeSteps = (stageId, ids) => {
        const removed = new Set(ids);
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
        })));
        if (selectedStepId !== undefined && removed.has(selectedStepId))
            setSelectedStepId(undefined);
    };
    const removeStep = (stageId, stepId) => {
        removeSteps(stageId, [stepId]);
    };
    const addStep = (stageId) => {
        const stepId = newId('step');
        patchStages(stages => stages.map(stage => {
            if (stage.id !== stageId)
                return stage;
            const count = stage.steps.length;
            // 命令必填：新 step 默认带 shell 命令（编辑器直接显示，不做「+命令」占位）。
            return { ...stage, steps: [...stage.steps, { id: stepId, name: `${t('editor.step.placeholder')} ${count + 1}`, command: createCommand('shell') }] };
        }));
        // 下钻态添加 step：自动选中新 step（右侧面板立即显示其配置）。
        if (drillStageId === stageId)
            setSelectedStepId(stepId);
    };
    const addStage = () => {
        const count = definition.stages.length;
        const stage = createStage(`${t('editor.stage.placeholder')} ${count + 1}`);
        patchStages(stages => [...stages, stage]);
        setSelectedStageId(stage.id);
        setDrillStageId(undefined);
    };
    /** 删除 Stage（面板移除按钮 / 画布键盘删除共用）：清理其余 Stage 指向它的流控引用。 */
    const removeStages = (ids) => {
        const removed = new Set(ids);
        patchStages(stages => stages
            .filter(stage => !removed.has(stage.id))
            .map(stage => ({
            ...stage,
            branches: (stage.branches ?? [])
                .filter(branch => branch.next === undefined || !removed.has(branch.next))
                .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && removed.has(branch.loop.next)
                ? { ...branch, loop: { ...branch.loop, next: undefined } }
                : branch),
        })));
        if (drillStageId !== undefined && removed.has(drillStageId))
            setDrillStageId(undefined);
        if (selectedStageId !== undefined && removed.has(selectedStageId)) {
            const remaining = definition.stages.filter(stage => !removed.has(stage.id));
            setSelectedStageId(remaining[0]?.id);
        }
    };
    const removeStage = (stageId) => {
        removeStages([stageId]);
    };
    /** 下钻：点 Stage 节点 → 进入该 Stage 的 Step DAG（微流程），默认选中首个 Step。 */
    const drillStage = (stageId) => {
        setDrillStageId(stageId);
        setSelectedStageId(stageId);
        setSelectedStepId(definition.stages.find(stage => stage.id === stageId)?.steps[0]?.id);
    };
    /** 单击选中 Stage（右侧面板同步显示该 Stage 的配置）。 */
    const selectStage = (stageId) => {
        setSelectedStageId(stageId);
        setSelectedStepId(undefined);
    };
    const backToStages = () => {
        setDrillStageId(undefined);
        setSelectedStepId(undefined);
    };
    /** 连线落点：统一并入 branches。Step 层回环连线（target 为更早 step）自动附加 loop。 */
    const connectTargets = (flow, target, isBackEdge) => {
        const branches = flow.branches ?? [];
        const existing = new Set(branches.map(branch => branch.next).filter((id) => id !== undefined && id !== ''));
        if (existing.has(target))
            return { ...flow };
        if (isBackEdge) {
            // 回环连线：自动附加 loop（maxIterations 默认 3，next = 回边目标），loop 必填。
            return { ...flow, branches: [...branches, { next: target, loop: { maxIterations: 3, next: target } }] };
        }
        return { ...flow, branches: [...branches, { next: target }] };
    };
    /** 拖拽连线：Stage 层 source → target（统一并入并行 branches）。Stage DAG 不允许循环：回环连线被拒绝。 */
    const connectStage = (source, target) => {
        if (wouldCreateStageCycle(definition.stages, source, target))
            return;
        patchStages(stages => stages.map(stage => (stage.id === source
            ? { ...stage, ...connectTargets(stage, target, false) }
            : stage)));
    };
    /** 拖拽连线：Step 层 source → target。若 target 是该 Stage 内更早的 step（数组顺序），
     *  视为回环连线：自动附加 loop（循环必填），画布以红色虚线回边展示。 */
    const connectStep = (source, target) => {
        if (drillStageId === undefined)
            return;
        patchStages(stages => stages.map(stage => {
            if (stage.id !== drillStageId)
                return stage;
            const sourceIndex = stage.steps.findIndex(step => step.id === source);
            const targetIndex = stage.steps.findIndex(step => step.id === target);
            const isBackEdge = sourceIndex >= 0 && targetIndex >= 0 && targetIndex < sourceIndex;
            return { ...stage, steps: stage.steps.map(step => (step.id === source
                    ? { ...step, ...connectTargets(step, target, isBackEdge) }
                    : step)) };
        }));
    };
    /** 画布键盘删除节点（Delete/Backspace）：按层级批量删除并同步模型。 */
    const deleteNodes = (nodeIds) => {
        if (drillStageId === undefined)
            removeStages(nodeIds);
        else
            removeSteps(drillStageId, nodeIds);
    };
    /** 画布键盘删除边：清掉 source 指向 target 的流控引用（branches[].next / branches[].loop.next）。 */
    const deleteEdges = (edges) => {
        if (edges.length === 0)
            return;
        if (drillStageId === undefined) {
            patchStages(stages => stages.map(stage => {
                const targets = new Set(edges.filter(edge => edge.source === stage.id).map(edge => edge.target));
                if (targets.size === 0)
                    return stage;
                return {
                    ...stage,
                    branches: (stage.branches ?? [])
                        .filter(branch => branch.next === undefined || !targets.has(branch.next))
                        .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && targets.has(branch.loop.next)
                        ? { ...branch, loop: { ...branch.loop, next: undefined } }
                        : branch),
                };
            }));
        }
        else {
            patchStages(stages => stages.map(stage => (stage.id !== drillStageId ? stage : {
                ...stage,
                steps: stage.steps.map(step => {
                    const targets = new Set(edges.filter(edge => edge.source === step.id).map(edge => edge.target));
                    if (targets.size === 0)
                        return step;
                    return {
                        ...step,
                        branches: (step.branches ?? [])
                            .filter(branch => branch.next === undefined || !targets.has(branch.next))
                            .map(branch => branch.loop !== undefined && branch.loop.next !== undefined && targets.has(branch.loop.next)
                            ? { ...branch, loop: { ...branch.loop, next: undefined } }
                            : branch),
                    };
                }),
            })));
        }
    };
    const runSave = async () => {
        setSaveState({ kind: 'pending' });
        try {
            const savedId = await save(id, serializeWorkflowYaml(definition));
            setId(savedId);
            onSaved?.(savedId);
            setDefinition(current => withDefinitionId(current, savedId));
            setSaveState({ kind: 'ok' });
        }
        catch (error) {
            const { message, details } = describeSaveError(error);
            setSaveState({ kind: 'error', message, details });
        }
    };
    const selectedStage = definition.stages.find(stage => stage.id === selectedStageId) ?? definition.stages[0];
    const drilledStage = drillStageId === undefined
        ? undefined
        : definition.stages.find(stage => stage.id === drillStageId);
    return (_jsxs("section", { className: css.editor, "aria-label": t('editor.title'), "data-sandore-dag-editor": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('editor.title') }), _jsx(Button, { size: "sm", variant: "primary", disabled: saveState.kind === 'pending', onClick: () => { void runSave(); }, children: saveState.kind === 'pending' ? t('editor.saving') : t('editor.save') })] }), saveState.kind === 'ok' && (_jsx("p", { className: css.success, role: "status", children: t('editor.save.success') })), saveState.kind === 'error' && (_jsx("p", { className: css.error, role: "alert", children: saveState.details === undefined
                    ? t('editor.save.failed', { message: saveState.message })
                    : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` }) })), _jsxs("div", { className: css.canvasRow, children: [_jsxs("div", { className: css.canvas, children: [_jsxs("div", { className: css.canvasTabs, children: [drillStageId !== undefined && (_jsxs("button", { type: "button", className: css.backBtn, onClick: backToStages, children: ["\u2190 ", t('editor.stageDag')] })), _jsx("span", { className: css.crumb, children: drillStageId === undefined ? t('editor.stageDag') : (drilledStage?.name ?? drillStageId) }), drillStageId === undefined ? (_jsx(Button, { size: "sm", variant: "outline", icon: _jsx(IconPlusOutline16, {}), onClick: addStage, children: t('editor.stage.add') })) : drilledStage !== undefined ? (_jsx(Button, { size: "sm", variant: "outline", icon: _jsx(IconPlusOutline16, {}), onClick: () => { addStep(drilledStage.id); }, children: t('editor.step.add') })) : null] }), _jsx(ReactFlowProvider, { children: _jsx(DagCanvas, { definition: definition, drillStageId: drillStageId, selectedStageId: selectedStageId, selectedStepId: selectedStepId, onDrillStage: drillStage, onSelectStep: setSelectedStepId, onSelectStage: selectStage, onConnectStage: connectStage, onConnectStep: connectStep, onDeleteNodes: deleteNodes, onDeleteEdges: deleteEdges, t: t }) })] }), _jsx("aside", { className: css.panel, "data-sandore-dag-panel": true, children: drillStageId === undefined ? (selectedStage === undefined ? (_jsx("span", { className: css.panelEmpty, children: t('editor.steps.empty') })) : (_jsx("div", { className: css.panelBody, children: _jsx(StageEditor, { stage: selectedStage, targets: definition.stages
                                    .filter(stage => stage.id !== selectedStage.id)
                                    .filter(stage => !wouldCreateStageCycle(definition.stages, selectedStage.id, stage.id))
                                    .map(stage => ({ id: stage.id, name: stage.name })), onChange: next => { updateStage(selectedStage.id, next); }, onRemove: () => { removeStage(selectedStage.id); }, t: t }) }))) : (selectedStepId === undefined || drilledStage === undefined ? (_jsx("span", { className: css.panelEmpty, children: t('editor.steps.empty') })) : ((() => {
                            const step = drilledStage.steps.find(candidate => candidate.id === selectedStepId);
                            if (step === undefined)
                                return _jsx("span", { className: css.panelEmpty, children: t('editor.steps.empty') });
                            return (_jsx("div", { className: css.panelBody, children: _jsx(StepEditor, { step: step, targets: drilledStage.steps.filter(candidate => candidate.id !== step.id).map(candidate => ({ id: candidate.id, name: candidate.name ?? candidate.id })), onChange: next => { updateStep(drilledStage.id, step.id, next); }, onRemove: () => { removeStep(drilledStage.id, step.id); }, t: t }) }));
                        })())) })] }), _jsx(DisclosureRow, { icon: _jsx(IconChevronRightOutline14, {}), title: t('editor.preview'), open: previewOpen, expandable: true, onToggle: () => { setPreviewOpen(current => !current); }, previewChevron: false, rowClassName: css.previewHeader, children: _jsx("div", { className: css.previewBody, children: _jsx(CodeBlock, { code: preview, lang: "yaml", copyLabel: t('editor.preview') }) }) })] }));
}
//# sourceMappingURL=DagEditor.js.map