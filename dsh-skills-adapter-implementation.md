# dsh-skills-adapter：详细实施方案

> 目标：把 Claude Code Skills 接入 DSH，支持项目级与用户级 Skills，并在 DSH Web UI 中提供技能列表与详情展示；优先复用 DSH 现有 Provider，不足时实现兼容 Provider；通过 npm bundle 和 `dsh plugin add` 安装。

## 1. 目标与边界

### 1.1 目标

- 遵循 DSH 插件与 Cordis 生命周期规范。
- 支持项目级 `.claude/skills/` 和用户级 `~/.claude/skills/`。
- 解析 `SKILL.md` 的 YAML frontmatter 与 Markdown 正文。
- 复用 DSH `ctx.skills` Registry 和现有 Skill Consumer。
- 支持按需读取 Skill 正文及相对资源引用。
- 在 Web UI 中显示技能列表、详情、来源与调用策略。
- 可通过 `dsh plugin --profile <profile> add dsh-skills-adapter` 安装和卸载。
- 发布独立 npm 包。

### 1.2 非目标

- 不重新实现 DSH Registry 或模型 Skill 工具。
- 不假设 Claude Code 的所有工具、Hooks、授权和运行时语义均可移植。
- 不自动执行 Skill 中提到的 shell 命令或脚本。
- 不在浏览器中直接读取宿主机文件系统。
- 不把所有 Skill 正文一次性注入 system prompt。

## 2. 总体架构

```text
Claude Skills 文件系统
  ├── 项目级：<workspace>/.claude/skills/<name>/SKILL.md
  └── 用户级：~/.claude/skills/<name>/SKILL.md
                |
                v
       dsh-skills-adapter
       ├── 目录发现与路径解析
       ├── Frontmatter 兼容与校验
       ├── SkillCandidate / SkillDefinition 转换
       └── 文件变化与生命周期
                |
                v
          DSH ctx.skills
       ├── Registry / 合并 / 调用策略
       ├── list / get / snapshot
       └── 现有 dsh-tool-skill Consumer
                |
        +-------+--------+
        |                |
        v                v
     模型调用          Web UI
                    ├── Skill 列表
                    ├── 搜索与来源筛选
                    └── Skill 详情
```

核心原则：适配器只补齐 Claude Skills 的来源兼容和展示功能，不建立第二套 Registry。

## 3. 开发前：锁定 DSH 版本并核对 API

DSH 仓库和公开 API 可能随版本变化。先记录目标 commit，并以该版本源码和类型定义为准，不要直接照搬未经编译验证的示例。

```bash
git rev-parse HEAD
```

检查以下位置（具体路径以实际仓库为准）：

| 检查项 | 需要确认的内容 |
|---|---|
| `packages/skill/skill-filesystem/src/index.ts` | Provider 配置、`customSkillDirs`、默认目录、文件系统访问方式 |
| `packages/skill/skill/src/index.ts` | `ctx.skills`、Provider 注册、`list()` / `get()` / `snapshot()`、公开类型 |
| `packages/skill/tool-skill/src/index.ts` | 模型侧如何列举与加载 Skill |
| `packages/client/ui-skill/` | 现有 Skill 建议、调用和详情展示 |
| `packages/client/` | Client 插件入口、`dsh.client` 声明、客户端 slots 和 API |
| Web 服务/RPC 源码 | 现有路由、Session 上下文、鉴权与调用方式 |
| `packages/bundle/web-app/cordis.patch.yml` | Web bundle 如何注册服务端和客户端插件 |
| 发布文档 | bundle manifest、版本兼容与 `dsh plugin` 安装规范 |

公开参考入口：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-skill/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/AGENTS.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md

### 3.1 Provider 复用策略

先验证现有 filesystem Provider 是否能满足两种目录：

- 用户级目录是固定路径，可尝试通过 `customSkillDirs` 接入。
- 项目级目录随当前工作区变化，必须确认 Provider 是否按每次查询的 `cwd` 解析路径。
- 如果 `customSkillDirs` 只接受固定目录，不能直接把相对路径配置一次后就认为每个项目都能生效。
- 如果现有 Provider 不支持 `.claude/skills` 的动态工作区解析，则新增 Claude 兼容 Provider。
- 自定义 Provider 只负责发现、解析和加载 Claude Skill；仍复用 `ctx.skills` Registry、调用策略和现有模型 Consumer。

## 4. 推荐项目结构

```text
dsh-skills-adapter/
├── packages/
│   ├── skills-adapter/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── claude-provider.ts
│   │   │   ├── discover.ts
│   │   │   ├── frontmatter.ts
│   │   │   ├── paths.ts
│   │   │   └── config.ts
│   │   └── tests/
│   │       ├── frontmatter.test.ts
│   │       ├── discover.test.ts
│   │       ├── provider.test.ts
│   │       └── integration.test.ts
│   └── client-skills/
│       ├── src/
│       │   ├── index.ts
│       │   └── client/
│       │       ├── index.ts
│       │       ├── api.ts
│       │       ├── store.ts
│       │       ├── SkillCatalogPage.tsx
│       │       ├── SkillDetailPanel.tsx
│       │       └── styles.module.css
│       └── tests/
├── fixtures/
│   └── claude-skills/
│       └── example-skill/
│           ├── SKILL.md
│           ├── references/
│           └── assets/
├── cordis.patch.yml
├── package.json
├── pnpm-workspace.yaml
├── README.md
├── LICENSE
└── CHANGELOG.md
```

如果 DSH 的 Client bundle 构建流程更适合独立发布，可以将 `client-skills` 拆成单独 npm 包；第一版推荐由一个 bundle 统一安装服务端和客户端插件。

## 5. Skill 目录与解析规则

### 5.1 第一版支持范围

- 项目级：`<workspace>/.claude/skills/<skill-name>/SKILL.md`
- 用户级：`~/.claude/skills/<skill-name>/SKILL.md`
- 可选自定义目录：通过插件配置添加。

目录布局是计划支持的默认值；实际用户目录应允许配置，避免假设所有安装都使用完全相同的路径。

### 5.2 发现规则

1. 以当前 DSH 工作区 `cwd` 为基准解析项目根目录。
2. 检查根目录是否存在；不存在时按空目录处理。
3. 只扫描 Skills 根目录的直接子目录，不无限递归。
4. 在每个子目录下查找 `SKILL.md`。
5. 解析 frontmatter 并验证 `name`、`description`。
6. 记录文件 locator、资源根目录、来源和必要元数据。
7. 单个 Skill 无效时记录诊断并继续扫描其他条目。
8. 区分“目录不存在”和“目录读取失败”；临时错误不应被误判为所有 Skill 已删除。

### 5.3 Frontmatter 示例

```markdown
---
name: code-review
description: Review code for correctness, maintainability, and common bugs.
---

# Code Review

Review the supplied code carefully.

Read references/review-checklist.md when more details are needed.
```

建议使用成熟 YAML/frontmatter 解析器，不要用简单正则实现完整 YAML 语义。

内部解析结构可设计为：

```ts
interface ParsedSkill {
  name: string
  description: string
  metadata: Record<string, unknown>
  content: string
  modelInvocable: boolean
  userInvocable: boolean
}
```

### 5.4 元数据兼容

| Claude 字段 | 处理建议 |
|---|---|
| `name` | 映射到 DSH Skill 名称并校验 |
| `description` | 映射到 DSH 描述 |
| `metadata` | 保留原始元数据 |
| `disable-model-invocation` | 映射为模型调用策略 |
| `user-invocable` | 映射为用户调用策略 |
| `allowed-tools` | 第一版保留，不自动授予权限 |
| `context`、`agent`、`hooks` | 保留字段，明确记录未实现的运行时语义 |
| 未知字段 | 默认保留，不擅自执行或赋予权限 |

`disable-model-invocation` 与 `user-invocable` 控制不同调用入口，不应合并成单一 `enabled` 字段。

## 6. Provider 实现设计

DSH 的公开 Skills Provider 接口（以目标版本类型定义为准）包括 Provider 身份、`list()`、`get()` 以及注册生命周期控制。

### 6.1 候选项 locator

```ts
interface ClaudeSkillLocator {
  skillFile: string
  skillRoot: string
  source: 'claude-project' | 'claude-user' | 'custom'
}
```

候选项应保存名称、描述、调用策略、来源、rank、locator 和资源基址。locator 是 Provider 内部数据，不应原样暴露给浏览器。

### 6.2 `list()` 负责

- 解析当前工作区和用户级 Skills 根目录。
- 扫描 `SKILL.md`。
- 解析 frontmatter。
- 转换成 DSH 公开的 `SkillCandidate` 类型。
- 根据 DSH Registry 约定设置来源、调用策略与优先级。
- 尊重 `AbortSignal`，对单个无效条目做隔离处理。

### 6.3 `get()` 负责

- 从 locator 获取已发现的 Skill 文件。
- 重新读取文件，以取得最新内容。
- 重新验证名称、元数据和调用策略。
- 返回 DSH 的 `SkillDefinition`。
- 正确设置资源基址。
- 处理文件删除、权限错误和取消请求。

不要把所有 Skill 正文在 `list()` 阶段加载并塞进模型上下文。

### 6.4 文件系统访问

生产实现应优先使用 DSH 注入的文件系统服务（例如目标版本公开的 `ctx.fs`），并遵守工作区或沙箱边界。不要未经核对就直接使用 Node `fs` 访问宿主机目录，因为 DSH 的运行环境可能采用独立的工作区文件系统。

### 6.5 路径安全

- 将目标资源路径规范化后再读取。
- 检查资源是否位于允许的 Skill 根目录内。
- 对符号链接校验实际目标路径。
- 默认拒绝目录外的路径逃逸。
- Skill 正文与附属文件均视为不可信内容。
- 不自动执行脚本或命令。

## 7. 插件入口

下面是入口结构示意，需按目标 DSH 版本核对实际的包导出、配置 schema 和 Provider 类型：

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createClaudeSkillsProvider } from './claude-provider.js'

export const name = 'dsh-skills-adapter'
export const inject = ['skills']

export const Config = z.object({
  enabled: z.boolean().default(true),
  projectSkillDirName: z.string().default('.claude/skills'),
  userSkillsDir: z.string(),
  watch: z.boolean().default(true),
})

export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  ctx.skills.registerProvider((control) =>
    createClaudeSkillsProvider(ctx, control, {
      projectSkillDirName: config.projectSkillDirName,
      userSkillsDir: config.userSkillsDir,
      watch: config.watch,
    }),
  )
}
```

注意：

- `Context`、`Config`、`registerProvider()` 和 Provider 类型必须以目标版本实际导出的定义为准。
- 文件监听必须真实实现，且在 Provider 生命周期结束时关闭。
- `userSkillsDir` 需要合理的默认值与路径展开逻辑。
- `watch` 配置不能只是声明而没有行为。
- 若现有 Provider 已经完全满足需求，应优先配置复用，不要保留重复实现。

## 8. Web UI 技能目录与详情

### 8.1 功能范围

新增一个 Skills 目录页，支持：

- 显示项目级和用户级 Skills。
- 按名称、描述搜索。
- 显示来源与调用策略。
- 点击条目查看完整 Markdown 正文。
- 展示加载、空状态、错误和目录不完整状态。
- 刷新目录。
- 切换工作区后读取对应的目录。
- 安全渲染 Markdown，不允许正文注入可执行 HTML。

DSH 已有的 Client Skill 插件可能提供 `/` 建议、`/name` 调用和 Instructions 卡片。优先复用这些交互，不要重复实现模型调用入口；新增目录页主要承担发现、浏览和详情查看。

### 8.2 推荐目录

```text
packages/client-skills/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── client/
        ├── index.ts
        ├── api.ts
        ├── store.ts
        ├── SkillCatalogPage.tsx
        ├── SkillDetailPanel.tsx
        └── styles.module.css
```

### 8.3 数据接口设计

建议把 Registry 能力映射为列表和详情查询。以下是适配器的接口设计，并不表示 DSH 当前已经存在同名 HTTP 路由。

```ts
interface SkillsCatalogResponse {
  complete: boolean
  skills: Array<{
    name: string
    description: string
    source: string
    invocation: {
      modelInvocable: boolean
      userInvocable: boolean
    }
  }>
}

interface SkillDetailResponse {
  name: string
  description: string
  source: string
  content: string
  invocation: {
    modelInvocable: boolean
    userInvocable: boolean
  }
}
```

- 列表接口使用 DSH 现有 Registry 的摘要能力。
- 详情接口按需调用 `ctx.skills.get()` 或该版本提供的等效方法。
- 使用 DSH 正式 RPC/Session 机制和鉴权方式。
- 不将绝对路径、locator 或 Provider 内部对象发送给浏览器。
- 不让浏览器传任意文件路径来读取服务端文件。
- 目录查询必须绑定正确的 `cwd` 和 Scope，防止切换项目后展示旧目录。

### 8.4 Client 插件集成

DSH Client 插件应遵循目标版本的 Client 插件规范，检查 `dsh.client` 声明、`./client` 导出、slots 注册方式和 Web bundle 构建要求。

不要假设一定存在名为 `skills-page` 的 slot。先阅读已有客户端插件和 slots 的类型定义，选择真实可用的扩展点；若需要新增只读 RPC，也应按 DSH 现有注册机制实现。

## 9. Bundle 与 npm 发布

### 9.1 服务端 bundle manifest

示意结构：

```json
{
  "name": "dsh-skills-adapter",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "files": [
    "dist",
    "cordis.patch.yml",
    "README.md",
    "LICENSE"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

实际包还需声明与目标 DSH 版本匹配的 `dependencies`、`peerDependencies`、类型入口和构建脚本。不要将示意版本号或占位符原样发布。

### 9.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-skills-adapter
      name: dsh-skills-adapter
      config:
        enabled: true
        projectSkillDirName: .claude/skills
        watch: true

    - id: dsh-client-skills-catalog
      name: dsh-client-skills-catalog
```

客户端包必须实际提供 DSH 要求的 Client 插件入口与导出；仅在 patch 中写一行不会自动生成页面。

### 9.3 Client 包清单示意

```json
{
  "name": "dsh-client-skills-catalog",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client/index.js"
  },
  "dsh": {
    "client": {
      "platform": "web"
    }
  }
}
```

应根据目标 DSH 版本的 Client 插件规范补齐必需字段、依赖和构建输出。

### 9.4 安装与发布

本地构建：

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

使用 tarball 在独立 profile 中验证：

```bash
dsh plugin --profile skills-test add /absolute/path/dsh-skills-adapter-0.1.0.tgz
dsh --profile skills-test --dump-config
dsh --profile skills-test
dsh plugin --profile skills-test remove dsh-skills-adapter
```

确认包名可用、版本兼容性已验证后发布：

```bash
npm login
npm publish --access public
```

正式发布后，用户可以通过 DSH 安装：

```bash
dsh plugin --profile web add dsh-skills-adapter
dsh --profile web
```

普通 `npm install` 只安装包，不保证自动激活 DSH 插件；`npx` 更适合具有 CLI 入口的包，本项目第一版应优先保证 `dsh plugin add` 流程。

## 10. 测试计划

### 10.1 服务端单元测试

- 合法 frontmatter 解析。
- 缺失字段、非法 YAML 与未知字段。
- 项目级与用户级目录发现。
- 自定义目录生效。
- 不把 `references/` 当成 Skill。
- 同名 Skill 的 Registry 优先级。
- 模型调用和用户调用策略分别映射。
- 正文更新后重新加载。
- 文件删除、权限错误和取消请求。
- 路径逃逸与符号链接边界。
- Provider 卸载后清理监听器与注册。

### 10.2 Web UI 测试

- 列表加载、搜索、空状态和错误状态。
- 项目切换后目录更新。
- 详情懒加载。
- Markdown 安全渲染。
- 超长正文与资源缺失处理。
- 不暴露绝对路径和内部 locator。
- Session/Scope 隔离。

### 10.3 集成验收

1. DSH 启动时 Provider 注册成功。
2. 项目级与用户级 Skills 都能显示。
3. Web UI 列表显示名称、描述、来源和调用策略。
4. 点击条目后能读取详情。
5. 现有模型 Skill 工具能加载相同内容。
6. 文件变化后目录或详情更新。
7. 插件卸载后不残留 Provider、监听器或客户端扩展。
8. 在干净 profile 中安装 tarball 后仍能正常运行。

## 11. 里程碑与交付顺序

### M1：验证现有能力

- 锁定 DSH commit。
- 验证 `customSkillDirs` 与动态 `cwd`。
- 验证 `ctx.skills` 的公开接口。
- 验证现有 Web Client Skill 能力。

**验收：** 明确哪些能力直接复用，哪些必须自定义。

### M2：服务端 MVP

- 支持项目级与用户级目录。
- 完成 frontmatter 转换。
- 注册 Provider。
- 接入现有 Skill Consumer。

**验收：** Skill 能在 DSH 中列出并按需加载。

### M3：Web UI

- 增加目录页、搜索与详情面板。
- 复用现有 RPC/Session 机制。
- 补齐错误、加载、刷新和安全处理。

**验收：** Web UI 能浏览与查看同一份 Registry 数据。

### M4：发布

- 完成单元与集成测试。
- 构建 bundle 与 Client 插件。
- 在干净 profile 中验证安装与卸载。
- 发布 npm 包并维护兼容版本说明。

## 12. 最终验收清单

- [ ] 遵循目标 DSH 版本的插件规范。
- [ ] 通过 `dsh plugin add` 安装与卸载。
- [ ] 项目级 `.claude/skills/` 可被发现。
- [ ] 用户级 `~/.claude/skills/` 可被发现。
- [ ] frontmatter 字段映射正确。
- [ ] 未知字段保留且不会被自动执行。
- [ ] Skill 正文按需加载。
- [ ] 相对资源路径可用且通过安全校验。
- [ ] Web UI 显示列表、搜索与详情。
- [ ] 工作区切换后数据正确更新。
- [ ] 复用现有 DSH Registry 与 Skill Consumer。
- [ ] Provider 和客户端扩展在卸载时清理。
- [ ] npm tarball 在干净环境中安装成功。
- [ ] README 记录安装方式、配置项、兼容性和已知限制。

## 13. 最终建议

采用“先复用、再补齐”的路线：

1. 先验证现有 filesystem Provider 是否能通过配置覆盖用户级目录。
2. 对动态项目级 `.claude/skills/`，必要时实现轻量兼容 Provider。
3. Registry、模型 Consumer 和现有 Skill 调用交互尽量复用。
4. Web UI 使用正式的 DSH Client 插件与 RPC/Session 机制，不直接访问文件系统。
5. 将服务端和客户端扩展纳入一个可安装的 bundle，最终通过 `dsh plugin add` 分发。

所有接口名称、配置字段、包版本和客户端 slot 都必须在目标 DSH commit 上核实并编译验证；本文代码是实施骨架，不能替代针对具体版本的类型检查与集成测试。
