# Clean TypeScript 编码规范 —— @meiyukichan/claude-sdk 公共入口/构建配置 + 依赖注入基座扩展

## 1. Scope

- **Requirement summary**: 为 `@meiyukichan/claude-sdk`（packages/sdk/claude）新增 `src/index.ts` 公共入口（re-export 全部公开 API），package.json 补 `main/module/exports/types/files/scripts.build`，tsconfig 补 `outDir/declaration`，使包名可被 Node 与 TS 解析到 dist/；扩展 `SessionManagerOptions` 四个注入点（默认指向 SDK 模块级函数）与 `QueryLike` 的 `rewindFiles`/`setPermissionMode` 方法签名，现有 4 处 FakeQuery 仍通过类型检查。
- **Code features affected**: 模块导出与 re-export、export type、接口类型声明、函数默认值注入、类实现接口、构建配置、公共导出文档化、命名。

## 2. Guidelines

### 模块导出与公共入口（src/index.ts）

##### SFS.06 使用命名导出，禁止默认导出 [High]

**[Description]**

所有代码中使用命名导出。不要使用默认导出。这确保所有导入遵循统一的模式。

**为什么？**

默认导出没有规范名称，这使得集中维护变得困难，而对代码所有者几乎没有好处，包括可能降低可读性。命名导出有一个好处：当导入语句尝试导入未声明的内容时会报错。

**[Compliant]**

```ts
// Use named exports:
export class Foo { ... }
```

##### SFS.07 导出可见性：最小化导出 API 表面 [High]

**[Description]**

TypeScript 不支持限制导出符号的可见性。只导出在模块外部使用的符号。通常最小化模块的导出 API 表面。

##### SFS.10 import type / export type [High]

**[Description]**

当仅将导入的符号用作类型时，可以使用 `import type {...}`。对值使用常规导入。

重新导出类型时使用 `export type`。

**为什么？**

`export type` 对于文件转译中的类型重新导出很有用。`export type` 也可能有助于避免为 API 导出值符号。然而它不能提供保证：下游代码可能通过不同路径导入 API。分割和保证 API 类型与值用法的好方法是实际将符号拆分为例如 `UserService` 和 `AjaxUserService`。

**[Compliant]**

```ts
import type {Foo} from './foo';
import {Bar} from './foo';

import {type Foo, Bar} from './foo';
```

```ts
export type {AnInterface} from './foo';
```

##### SFS.11 使用模块而非命名空间 [High]

**[Description]**

TypeScript 支持两种组织代码的方法：**命名空间**和**模块**，但命名空间是禁止的。也就是说，代码**必须**使用 `import {foo} from 'bar';` 形式的导入和导出引用其他文件中的代码。

代码**禁止**使用 `namespace Foo { ... }` 结构。命名空间**只能**在与外部第三方代码接口时使用。要在语义上命名空间化代码，请使用单独的文件。

代码**禁止**使用 `require`（如 `import x = require('...');`）进行导入。使用 ES6 模块语法。

### 工具链与类型检查（package.json / tsconfig.json）

##### TC.01 所有 TypeScript 文件必须通过类型检查 [High]

**[Description]**

所有 TypeScript 文件必须使用标准工具链通过类型检查。

##### TC.02 禁止 @ts-ignore [High]

**[Description]**

不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。

### 接口与类型声明（SessionManagerOptions / QueryLike）

##### T.06 声明对象类型时优先使用接口 [Medium]

**[Summary]**: 声明对象类型时应使用接口而非对象字面量类型的类型别名（`interface User {...}` 优于 `type User = {...}`），两者几乎等价但接口工具支持更好，选择一种以防止变化。

##### T.04 优先可选字段/参数而非 `|undefined` [Medium]

**[Summary]**: 使用 `?` 可选参数和字段（隐式包含 `|undefined` 但可省略）而非 `|undefined` 类型，用于接口/类的可选字段与函数参数。

##### T.03 类型别名禁止包含 `|null` 或 `|undefined` [Medium]

**[Summary]**: 类型别名禁止在联合类型中包含 `|null` 或 `|undefined`；仅在具体使用处添加，空值应在值出现附近处理。

##### T.05 结构化类型：声明处显式包含类型 [Medium]

**[Summary]**: 类型系统是结构化的；提供基于结构的实现时在符号声明处显式包含类型，以获得更精确的类型检查和错误报告。

##### T.01 依赖类型推断 [Medium]

**[Summary]**: 可依赖类型推断；简单类型（string/number/boolean 字面量初始化）省略注解，复杂表达式添加注解，是否注解由审查者决定。

##### T.02 返回类型注解 [Medium]

**[Summary]**: 返回类型注解是否包含由作者决定；审查者可要求注解复杂返回类型，项目可本地规定始终包含。

##### T.09 避免 any [Medium]

**[Summary]**: `any` 是危险类型，可掩盖编程错误；优先更具体的类型、`unknown` 或抑制警告并记录原因。

### 函数与默认参数（DI 注入点）

##### LF.12 参数默认值：禁止副作用、保持简单 [Medium]

**[Summary]**: 可选函数参数可给默认初始化器，但初始化器禁止有任何可观察的副作用且应保持简单；可选参数多于少数几个且无自然顺序时优先用解构。

### 类实现接口（test 的 FakeQuery）

##### LF.03 类声明禁止分号结尾 [Medium]

**[Summary]**: 类声明禁止以分号结尾；包含类表达式的语句必须以分号结尾。

##### LF.07 用 readonly 标记不重赋值属性 [Medium]

**[Summary]**: 用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性（不必深度不可变）。

##### LF.09 优先函数声明定义命名函数 [Medium]

**[Summary]**: 定义命名函数时优先函数声明而非箭头函数或函数表达式；箭头函数可在需要显式类型注解等情况下使用。

### 注释与文档

##### CD.05 文档化所有顶层导出 [Medium]

**[Summary]**: 用 `/** JSDoc */` 向代码用户传达信息，避免仅重复属性/参数名称；用途不显而易见时也应文档化属性和方法。

##### CD.06 方法描述以第三人称动词短语开头 [Medium]

**[Summary]**: 方法描述以第三人称动词短语开头（非祈使句），隐含"此方法 ..."。

##### CD.07 注释应实际添加信息 [Medium]

**[Summary]**: 避免重复参数名称和类型的注释；`@param`/`@return` 仅在添加信息时需要，否则可省略。

##### CD.01 JSDoc 用于文档化，`//` 用于实现注释 [Medium]

**[Summary]**: 使用 `/** JSDoc */` 注释文档化，`// 行注释` 实现注释；多行注释必须用多个 `//` 单行注释而非 `/* */` 块注释。

##### CD.04 JSDoc 标签占据自己的行 [Medium]

**[Summary]**: 大多数 JSDoc 标签必须占据自己的行，标签在行首（`@param`/`@return` 各占一行）。

### 命名规范

##### N.05 大小写规则 [Medium]

**[Summary]**: 标识符按类型遵循大小写：class/interface/type/enum 用 `UpperCamelCase`；variable/parameter/function/method/property/module alias 用 `lowerCamelCase`；全局常量用 `CONSTANT_CASE`。

##### N.02 类型信息不入名，不特标接口 [Medium]

**[Summary]**: 名称不应装饰类型信息；不要特别标记接口（如 `IMyInterface`），为类引入接口时给它表达存在原因的名字。

##### N.03 描述性名称 [Medium]

**[Summary]**: 名称必须描述性、对新读者清晰；不用模糊缩写、不删字母缩写（≤10 行局部作用域可用短名称）。

##### N.06 禁止 `_` 前缀/后缀 [Medium]

**[Summary]**: 标识符禁止 `_` 前缀或后缀；`_` 禁止单独用作未使用参数标识符。

### 核心风格（typescript-core-style）

##### CS.06 TypeScript 使用 2 空格缩进 [Medium]

**[Summary]**: TypeScript 的缩进风格必须采用 2 个空格缩进。

##### CS.03/CS.04 使用单引号与显式分号 [Medium]

**[Summary]**: 使用单引号（'）；显式使用分号，不依赖自动分号插入。

##### CS.05 禁止 console.log [Medium]

**[Summary]**: 禁止使用 console.log，通过 logger 输出日志。

##### CS.07/CS.08 文件头 JSDoc 与导出方法 JSDoc [Medium]

**[Summary]**: 文件头部声明采用 `@author`/`@copyright` 样式的 JSDoc；类、main 方法、export 方法及重要方法必须有 JSDoc，常量用行前 `//` 注释。

##### CS.09 文件行数 [Medium]

**[Summary]**: 普通业务文件 300-500 行；组件/类文件 200-300 行；工具/配置文件 100-200 行；大型模块不超过 800 行。

##### SFB.01 UTF-8 与 ASCII 空格 [Medium]

**[Summary]**: 源文件使用 UTF-8 编码；除换行符外 ASCII 空格 (0x20) 是唯一空白字符，其余空白字符在字符串字面量中必须转义。

### 其他模块结构规则

##### SFS.03 同项目内优先相对导入 [Medium]

**[Summary]**: 引用同项目文件时应使用相对导入（`./foo`）而非绝对路径，并限制父目录层级数量。

##### SFS.01 文件顺序 [Medium]

**[Summary]**: 文件按顺序组成：版权信息 → `@fileoverview` JSDoc → 导入 → 实现，各部分之间恰好用一个空行分隔。

##### SFS.08 禁止 `export let` 可变导出 [Medium]

**[Summary]**: 禁止 `export let` 可变导出；需要外部可访问的可变绑定时应改用显式 getter 函数。

##### SFS.09 禁止容器类作命名空间 [Medium]

**[Summary]**: 不要创建带静态方法/属性的容器类作为命名空间手段；应导出单个常量和函数。

## 3. Security & production notes

- **构建产物与类型解析**：`dist/` 已由根 `.gitignore` 忽略，`main/module/exports/types` 必须指向构建产物（dist/index.js / dist/index.d.ts），且 `tsconfig` 的 `declaration: true` + `outDir: dist` 必须与 `files`（仅 dist）保持一致，否则消费者类型解析会落到源码路径、破坏包边界（关联 TC.01）。
- **注入点默认值安全**：`SessionManagerOptions` 四个新注入点默认指向 SDK 模块级函数，应使用 `options.fn ?? moduleFn` 的空值合并默认，而不是在参数上直接引用可变全局状态，避免默认初始化器副作用（关联 LF.12）。
- **QueryLike 签名扩展与测试兼容**：`rewindFiles`/`setPermissionMode` 新增方法后，4 处 `FakeQuery implements QueryLike` 必须补齐同签名实现才能通过类型检查；不要用 `@ts-ignore` 抑制类型错误来绕过（关联 TC.02）。
