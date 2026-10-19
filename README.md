# dsh_skills_adapter

把 Claude Code 风格的技能（`.claude/skills/`）接入 DeepSeek Harness 的插件。

## 它做什么

DSH 内置的 `skill-filesystem` Provider 只发现 `.dsh/skills` 与 `.agents/skills`，
不认识 Claude Code 的 `.claude/skills`。本插件注册一个额外的 Provider，
让 DSH 能在现有项目中直接使用已有的 Claude 技能，无需迁移文件。

**插件本身不携带任何技能内容**：技能文件始终留在原处，
插件只做原地读取。因此修改 `SKILL.md` 后立刻生效，无需重新安装。

| 技能位置 | 是否支持 | 说明 |
|---|---|---|
| `<项目>/.claude/skills/` | ✅ | 项目级，随工作目录变化 |
| `~/.claude/skills/` | ✅ | 用户级，任何工作目录下都可见 |
| `~/.costrict/skills/` | ✅ | Costrict 用户级，与上者独立维护 |

三者同时生效，**同名时优先级：项目级 > `.claude` 用户级 > `.costrict` 用户级**。

## 安装

```bash
npm pack
dsh plugin --profile <profile> add /绝对路径/dsh_skills_adapter-1.0.0.tgz
dsh --profile <profile>
```

卸载：

```bash
dsh plugin --profile <profile> remove dsh_skills_adapter
```

## 技能格式

每个技能是一个目录，内含一个 `SKILL.md`：

```markdown
---
name: code-review
description: Review code for correctness, maintainability, and common bugs.
---

# Code Review

需要时阅读 references/checklist.md。
```

`name` 与 `description` 为必填；缺失该技能会被跳过并记录日志，不影响其他技能。

### 支持的 frontmatter 字段

| 字段 | 作用 |
|---|---|
| `name` | 技能标识，必须为 kebab-case |
| `description` | 展示给模型的路由描述 |
| `whenToUse` | 可选的额外使用指引 |
| `disable-model-invocation` | 设为 `true` 时该技能不对模型展示（但仍可由用户以 `/name` 调用）|
| `user-invocable` | 设为 `false` 时该技能不对用户展示 |

`disable-model-invocation` 与 `user-invocable` 控制**不同的调用入口**，二者独立生效。

其余字段会被原样保留，不会被自动执行。

## 技能根如何确定

**项目级**：从查询的工作目录向上查找，直到找到包含 `.git` 的目录，与内置
`skill-filesystem` 为 `.dsh/skills` 使用的规则一致。因此在项目的任意子目录中
查询，都能发现同一批项目级技能。若向上始终找不到 `.git`，则以当前工作目录为准。

**用户级**：固定为 `~/.claude/skills` 与 `~/.costrict/skills`，与工作目录无关，
因此在任何项目中都可见。二者是相互独立的技能来源，各自维护、互不同步。

## 优先级

同名技能按 rank 去重，**数值小者优先**：

| rank | 来源 |
|---|---|
| 100 | `.dsh/skills`（内置，项目级）|
| **200** | **`<项目>/.claude/skills`（本插件，项目级）** |
| 300 | `customSkillDirs` 配置的目录 |
| **400** | **`~/.claude/skills`（本插件）** |
| 400 / 500 | 内置用户级 `.dsh` / `.agents` |
| **410** | **`~/.costrict/skills`（本插件）** |

即：`.dsh/skills` 优先于项目级 `.claude/skills`，后者又优先于两个用户级目录；
而 `~/.claude/skills` 与 `~/.costrict/skills` 同名时，以 `.claude` 版本胜出。

## 开发

```bash
./setup.sh        # 建立指向本地 DSH 部署的软链（每次 npm install 后都需重跑）
npm run typecheck
npm run build
```

`setup.sh` 是必要的：本插件依赖 DSH 宿主提供的 `@deepseek-ai/cordis` 与
`@deepseek-ai/dsh-skill`（见 `peerDependencies`），开发期通过软链指向本地部署。
`npm install` 会清理这类软链，因此安装依赖后需重新执行。

## 已知限制

- 不做文件监听：目录变化后需重新读取目录（每次 `list()` 都会重新扫描，因此不会读到过期数据）。
- 不递归扫描子目录，只识别 `.claude/skills/` 的直接子目录。
- `allowed-tools`、`context`、`agent`、`hooks` 等 Claude 专有字段会被保留但不生效。
- 不执行技能中提到的任何脚本或命令。

## 许可证

MIT
