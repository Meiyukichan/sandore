# Spec: dag-editor

## ADDED Requirements

### Requirement: Stage DAG 简化可视化
`DagEditor` SHALL 以简化形式（ui-primitives 节点列表 + 连线示意，无 React Flow）渲染工作流定义的 Stage DAG：Stage 节点（ID/名称/步骤数）按 stageInfos 顺序排列，Stage 间连线/箭头示意串行推进；SHALL NOT 引入 `@xyflow/react`/`@dagrejs/dagre` 等第三方 DAG 库。

#### Scenario: Stage 结构渲染
- **WHEN** 用户进入某定义的 DagEditor
- **THEN** 按定义顺序渲染各 Stage 节点（名称 + 所含 Step 数），Stage 间有连线示意

### Requirement: Step 查看与编辑
DagEditor SHALL 展示选中 Stage 内的 Step 列表（名称、command 类型 prompt/shell/agent/skill/mcp、inputFrom/outputTo 映射、passThroughVars、gates），并支持编辑 Step 字段（表单/字段编辑，非 YAML 裸编唯一途径）；分支（branches）与循环（loop）流控字段 SHALL 可查看与编辑。

#### Scenario: 查看 Step 详情
- **WHEN** 用户点击某 Stage 展开
- **THEN** 该 Stage 的 Step 列表显示名称、命令类型与关键映射字段

#### Scenario: 编辑 Step 字段
- **WHEN** 用户修改某 Step 的名称/命令值并确认
- **THEN** 编辑态（内存中的定义模型）更新，YAML 预览同步反映

### Requirement: YAML 预览与保存
DagEditor SHALL 提供定义的 YAML 预览（由编辑态定义模型序列化，格式与 `workflow/src/yaml-parser.ts` 往返一致），保存时经 `ctx.remote.sandore.updateYaml(id, yaml)` 持久化；保存失败 SHALL 呈现错误；保存成功 SHALL 提示并刷新预览基线。

#### Scenario: YAML 预览同步
- **WHEN** 用户在编辑态修改任一字段
- **THEN** YAML 预览区内容同步更新（序列化自当前编辑模型）

#### Scenario: 保存成功
- **WHEN** 用户点击保存且 `updateYaml` 返回 `{ok:true}`
- **THEN** 呈现保存成功提示，编辑基线更新为已保存内容

#### Scenario: 保存校验失败
- **WHEN** `updateYaml` 因 YAML/schema 校验失败返回 `{ok:false}`
- **THEN** 呈现错误信息（含校验错误详情），编辑态保留未保存内容

### Requirement: 新建定义
编排态「新增」SHALL 进入空白 DagEditor（默认最小合法定义骨架），首次保存经 `createDefinition({yaml})` 创建（生成 `wfl-{uuid}`），后续保存走 `updateYaml`。

#### Scenario: 新建并首次保存
- **WHEN** 用户从编排态新增定义并保存
- **THEN** 调用 `createDefinition` 创建定义，成功后进入已保存态（后续保存走 updateYaml）
