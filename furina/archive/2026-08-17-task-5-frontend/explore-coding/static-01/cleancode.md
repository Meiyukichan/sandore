### 1. Scope

- **Requirement summary**: 完成 sandore monorepo 挂载固化（cordis.yml 静态组合）与 typert 两阶段构建管线跑通：跨包导入改为显式包导入、wire 类型重导出、@Remote/zod 使用。
- **Code features affected**: 跨包导入/导出（package.json exports 子路径、import/export type）、wire 类型定义（interface/可选字段/联合类型）、构建工具链（tsc -b、tsdown、typertPlugin、生成代码）、装饰器、declare module 声明合并、命名与 JSDoc。

### 2. Guidelines

#### 跨包导入与导入路径

##### SF.IMP.01 Import paths [Required]

**[Description]**

TypeScript 代码**必须**使用路径导入其他 TypeScript 代码。路径可以是相对路径（以 `.` 或 `..` 开头）或基于根目录的路径（例如 `root/path/to/file`）。在引用同一（逻辑）项目中的文件时，**应该**使用相对导入（`./foo`）而非绝对导入（`path/to/foo`），这样可以移动项目而无需修改这些导入。考虑限制父目录层级（`../../../`）的数量，因为这样会使模块和路径结构难以理解。

**[Compliant]**

```
import {Symbol1} from 'path/from/root';
import {Symbol2} from '../parent/file';
import {Symbol3} from './sibling';
```

##### SF.IMP.02 Namespace versus named imports [Recommended]

具名导入与命名空间导入均可；频繁使用或名称清晰的符号优先具名导入，使用大型 API 中许多不同符号时优先命名空间导入。

##### SF.IMP.03 Renaming imports [Recommended]

应通过命名空间导入或重命名导出本身解决名称冲突；必要时可 `import {SomeThing as SomeOtherThing}`。

##### SF.TYP.01 Import type [Recommended]

仅将导入符号用作类型时用 `import type {...}`；也可用 `import {type Foo, Bar}`，对值用常规导入。

#### exports 子路径与类型重导出

##### SF.TYP.02 Export type [Required]

**[Description]**

重新导出类型时使用 `export type`，例如：`export type {AnInterface} from './foo';`。`export type` 对于文件转译中的类型重新导出很有用，也可能有助于避免为 API 导出值符号；然而它不能提供保证：下游代码可能通过不同路径导入 API。分割和保证 API 类型与值用法的好方法是实际将符号拆分为例如 `UserService` 和 `AjaxUserService`，这更不容易出错，也更好地传达意图。

**[Compliant]**

```
export type {AnInterface} from './foo';
```

##### SF.EXP.01 Named exports only [Required]

**[Description]**

所有代码中使用命名导出。不要使用默认导出。这确保所有导入遵循统一的模式。

**为什么？**

默认导出没有规范名称，这使得集中维护变得困难，而对代码所有者几乎没有好处，包括可能降低可读性。命名导出有一个好处：当导入语句尝试导入未声明的内容时会报错。此外，默认导出鼓励人们将所有内容放入一个大对象中作为命名空间。使用上述模式，我们有文件作用域，可用作命名空间；我们还有一个可能不必要的第二个作用域（类 `Foo`），在其他文件中可能被歧义地用作类型和值。相反，优先使用文件作用域进行命名空间化和命名导出。

**[Compliant]**

```
export class Foo { ... }

export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
  // only class stuff here
}
```

##### SF.EXP.02 Export visibility [Recommended]

TypeScript 不支持限制导出符号可见性，只导出在模块外部使用的符号，通常最小化模块的导出 API 表面。

##### SF.EXP.03 Mutable exports [Required]

可变导出产生难以理解和调试的代码，禁止 `export let`；如需外部可访问的可变绑定，应改用显式 getter 函数。

##### SF.EXP.04 Container classes [Required]

不要创建带静态方法或属性的容器类作为命名空间手段，应导出单个常量和函数。

#### wire 类型面拆分与定义

##### TYS.NUL.01 Nullable/undefined type aliases [Required]

类型别名**禁止**在联合类型中包含 `|null` 或 `|undefined`；代码**必须**只在实际使用别名时添加 `|null`/`|undefined`，并**应该**在值出现的附近处理空值。

##### TYS.NUL.02 Prefer optional over `|undefined` [Recommended]

使用可选字段（接口或类上）和参数（`?`）而不是 `|undefined` 类型；可选参数在其类型中隐式包含 `|undefined`。

##### TYS.STR.01 Use structural types [Required]

在提供基于结构的实现时，在符号的声明处显式包含类型（允许更精确的类型检查和错误报告）；使用接口定义结构类型而非类。

##### TYS.INT.01 Prefer interfaces over type literal aliases [Required]

声明对象的类型时，使用接口而不是对象字面量表达式的类型别名。

##### TYS.INF.01 Type inference [Recommended]

代码可以依赖类型推断；简单类型省略注解，复杂表达式添加注解；无值初始化的泛型（空数组/`Map`/`Set`）需显式如 `new Set<string>()`。

##### TYS.INF.02 Return types [Recommended]

是否为函数/方法包含返回类型注解由代码作者决定，审查者可要求注解以澄清复杂返回类型。

##### TYS.ARR.01 Array<T> [Required]

简单类型用 `T[]` 语法糖；复杂类型用 `Array<T>`；规则适用于嵌套每一级。

##### TYS.ANY.01 any [Required]

**考虑不要使用 `any`**；优先提供更具体类型、使用 `unknown`，或抑制 lint 警告并记录原因。

##### TYS.EMP.01 {} [Recommended]

不应将 `{}` 用于大多数用例；优先 `unknown`、`Record<string, T>`、`object`。

##### TYS.MAP.01 Mapped and conditional types [Recommended]

始终使用能表达代码的最简单类型构造；一点重复或冗长通常比复杂类型表达式的长期成本便宜。

#### typert 构建管线与工具链

##### TCH.01 TypeScript compiler / @ts-ignore ban [Required]

**[Description]**

所有 TypeScript 文件必须使用标准工具链通过类型检查。不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**：`@ts-expect-error` 抑制所有错误，很容易意外地过度匹配并抑制更严重的错误；应改为对单个表达式添加强制转换为预期类型或 `any` 并加说明性注释，或抑制 lint 警告并记录原因。

##### TCH.02 Conformance [Required]

必须遵守任何适用的全局或框架本地一致性规则（tsetse/tsec 等）。

##### POL.02 Generated code: mostly exempt [Required]

**[Description]**

构建过程生成的源代码不需要符合 Google 风格。但是，任何将从手写源代码引用的生成标识符必须遵循命名要求。作为一个特殊的异常，此类标识符允许包含下划线，这有助于避免与手写标识符冲突。

##### POL.01 Consistency [Required]

未解决的风格问题与同一文件（或同目录文件）中的现有代码保持一致；新文件必须使用 Google 风格。

##### POL.03 Deprecation [Recommended]

用 `@deprecated` JSDoc 标记弃用的方法/类/接口，并提供清晰的修复指导。

#### cordis.yml 静态组合与 declare module

##### SF.MOD.01 Use modules not namespaces [Required]

**[Description]**

TypeScript 支持命名空间和模块两种组织代码的方法，但命名空间是禁止的。代码**必须**使用 `import {foo} from 'bar';` 形式的导入和导出引用其他文件中的代码，**禁止**使用 `namespace Foo { ... }`（命名空间只能在与外部第三方代码接口时使用），**禁止**使用 `require`（如 `import x = require('...');`）进行导入，应使用 ES6 模块语法。

> 说明：cordis 的 `declare module 'cordis'`（Context/Service/Events 声明合并）属于与第三方框架接口的场景，为允许用法；但不得手写 `namespace Foo {}`。

##### LFE.DEC.01 Decorators [Required]

**[Description]**

不要定义新的装饰器，只使用框架定义的装饰器。使用装饰器时，装饰器**必须**紧跟在其装饰的符号前面，两者之间没有空行。

**[Compliant]**

```
/** JSDoc comments go before decorators */
@Component({...})  // Note: no empty line after the decorator.
class MyComp {
  @Input() myField: string;
}
```

##### LFE.CLS.01 Class declarations [Required]

类声明禁止以分号结尾；类方法声明禁止用分号分隔；方法/构造函数声明用单个空行与周围代码分隔。

##### LFE.ASS.01 Type and non-nullability assertions [Required]

类型断言（`x as SomeType`）与非空断言（`y!`）不安全，应优先运行时检查；断言必须用 `as` 语法（禁止尖括号）；对象字面量用类型注解 `: Foo` 而非 `as Foo`。

##### LFE.DIS.01 Disallowed features [Required]

禁止 `const enum`（用普通 `enum`）、`debugger`、`with`、`eval`/`Function` 构造、修改内置对象、非标准特性、原始类型包装器。

#### 命名与注释文档

##### NAM.01 Naming styles [Required]

类/接口/类型/枚举/装饰器/类型参数用 UpperCamelCase；变量/参数/函数/方法/属性/模块别名用 lowerCamelCase；全局常量值（含枚举值）用 CONSTANT_CASE。

##### NAM.02 Descriptive names [Required]

名称必须具有描述性；不使用读者不熟悉的缩写，不通过删除单词内部字母缩写（例外：10 行内局部作用域可用短名）。

##### NAM.03 Camel case [Required]

将缩写视为整词：`loadHttpUrl` 而非 `loadHTTPURL`（平台名如 `XMLHttpRequest` 除外）。

##### NAM.04 Type info not in names [Required]

类型信息不应出现在名称中；禁止 `_` 前缀/后缀、`opt_` 前缀、`IMyInterface`/`MyFooInterface` 标记；`Observable` 用 `$` 后缀是常见约定。

##### NAM.05 Constants [Required]

`CONSTANT_CASE` 表示值意图不被修改（含 `static readonly`）；只有模块级符号、模块级类静态字段、模块级枚举值可用 CONSTANT_CASE，局部变量用 lowerCamelCase。

##### NAM.06 Imports casing [Required]

模块命名空间导入使用 lowerCamelCase。

##### DOC.02 Document all top-level exports [Required]

模块的所有顶层导出应使用 `/** JSDoc */` 文档化；仅被工具消费而导出的符号（如 @NgModule 类）例外。

##### DOC.03 JSDoc type annotations redundant [Required]

JSDoc 类型注解在 TS 源码中冗余，禁止在 @param/@return 中重复声明类型。

##### DOC.04 Place documentation prior to decorators [Required]

装饰器场景下，JSDoc 写在装饰器之前，不在装饰器与被装饰语句之间写 JSDoc。

##### DOC.05 Make comments add information [Recommended]

注释必须提供实际信息，避免仅重复参数名和类型；`@param`/`@return` 仅在添加信息时使用。

##### CORE.01 Core style [Required]

使用 ES 模块；单引号；显式分号；2 空格缩进；禁止 console.log（通过 logger 输出）；Node 内置模块必须默认导入（`import fs from 'fs'`）；第三方库或多导出模块用命名空间导入。

##### CORE.02 JSDoc file header [Recommended]

文件头部采用 `/** 描述 @author ... @copyright ... */` 风格；类/export 方法/重要方法须有 JSDoc。

##### CORE.03 File line count [Recommended]

普通业务文件 300-500 行；组件/类 200-300 行；工具/配置 100-200 行；大型模块 ≤800 行。

##### SFB.01 UTF-8 [Required]

源文件 UTF-8 编码；特殊转义序列用 `\'`/`\n` 等而非数字转义（如 `
`），禁止八进制转义。

### 3. Security & production notes

- **SF.IMP.01**：跨包导入必须改为显式包导入 `@deepseek-ai/dsh-sandore-microflow/src/*`、`@deepseek-ai/dsh-sandore-tool/src/*`，禁止保留 `../../microflow/src/*` 跨包相对导入；否则 typert 分析（如 seam.ts 的 `import type { Agent } from '../../microflow/src/subagents.ts'`）会抛 TypertAnalysisError，构建管线无法跑通。
- **SF.TYP.02 + SF.EXP.01**：wire 类型（PingResponse/WorkflowDefinitionEntry/JobEntry/InstanceSummary/ArtifactEntry 及 Input 类型）拆分到 `./types` 子路径后，必须以 `export type {...} from '...'` 命名重导出，供 typert 生成物 .d.ts 引用；不得使用默认导出。
- **TCH.01**：对齐 tsc -b tsconfig.host.json → tsdown typertPlugin 两阶段管线后，所有文件必须通过 tsc 类型检查；禁止用 @ts-ignore 抑制 typert/tsdown 构建错误。
- **POL.02**：typert 生成物 .d.ts 属生成代码，豁免 Google 风格，但其被手写代码引用的 wire 类型标识符必须遵循命名要求。
- **SF.MOD.01**：cordis.yml 静态组合通过 `declare module 'cordis'` 声明合并 Context/Service/Events，属允许的第三方接口场景；禁止手写 `namespace` 或 `require`。
