import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'

/** 插件在 Cordis 配置树中的行标识。 */
export const name = 'dsh-skills-adapter'

/** Services required before `apply` runs. */
export const inject = ['skills']

/**
 * 项目级技能的注册表优先级：同一层内 rank 越小越优先，用于同名去重。
 * 内置文件系统 Provider 使用 100（project-dsh）到 500（user-agents）。
 * 我们取 200，使 `.dsh/skills` 在同名冲突时仍然胜出，
 * 同时项目级 `.claude/skills` 优先于用户级与本插件的其他来源。
 */
const PROJECT_RANK = 200

/**
 * 用户级技能的优先级。取 400 与内置的 user-dsh 同档，
 * 使同名时项目级技能（200）覆盖用户级技能。
 */
const USER_RANK = 400

/**
 * Costrict 用户级技能的优先级。取 410，略低于 `.claude/skills` 的 400，
 * 使两者存在同名技能时以 `.claude` 版本胜出——Costrict 目录只作为补充来源。
 */
const COSTRICT_RANK = 410

/** 项目级技能上报的来源分组。`SkillSource` 允许自定义字符串。 */
const SOURCE_PROJECT = 'claude-project'

/** 用户级 `.claude/skills` 技能上报的来源分组。 */
const SOURCE_USER = 'claude-user'

/** 用户级 `~/.costrict/skills` 技能上报的来源分组。 */
const SOURCE_COSTRICT = 'costrict-user'

/** 相对于项目根目录的技能目录名。 */
const SKILLS_DIR = '.claude/skills'

/** 用户主目录下的 Claude 技能目录名。 */
const USER_SKILLS_DIR = join('.claude', 'skills')

/** 用户主目录下的 Costrict 技能目录名。 */
const COSTRICT_SKILLS_DIR = join('.costrict', 'skills')

/** 标志一个目录是一个技能包的固定文件名。 */
const SKILL_FILE = 'SKILL.md'

/** 一个待扫描的技能根目录，连同它的来源与优先级。 */
interface SkillRoot {
  /** 待扫描目录的绝对路径。 */
  readonly dir: string
  /** 上报给消费方的来源分组。 */
  readonly source: string
  /** 注册表优先级，数值小者优先。 */
  readonly rank: number
}

/** Locator carried on every candidate and handed back to `get()`. */
interface ClaudeSkillLocator {
  readonly skillFile: string
  readonly skillRoot: string
  /**
   * 来源分组。必须一并存入 locator：`SkillDefinition` 不含该字段的来源信息，
   * 而 get() 返回的定义必须与候选保持一致，否则消费方看到的来源会前后矛盾。
   */
  readonly source: string
}

/**
 * 从 `cwd` 向上查找，直到找到包含 `.git` 的目录。
 * @param cwd - 起始目录，调用方已保证其不为 undefined。
 * @returns 项目根目录；若始终找不到 `.git`，则返回原始 `cwd`。
 */
function findProjectRoot(cwd: string): string {
  let current = cwd
  for (;;) {
    // `.git` 可能是目录（普通克隆），也可能是文件（worktree 或 submodule），
    // 所以正确的判断是"是否存在"，而不是 isDirectory()。
    if (existsSync(join(current, '.git'))) return current

    const parent = dirname(current)
    // 文件系统根目录的父目录是它自己，这正是向上查找的终止条件。
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * 列出本次查询需要扫描的全部技能根目录。
 *
 * 三个来源相互独立：项目级随 `cwd` 变化，两个用户级目录是固定路径。
 * 无论查询哪个工作区，用户级技能都应当可见。
 * @param cwd - 当前工作区目录；缺省时跳过项目级扫描。
 * @returns 技能根列表，按优先级从小到大排列。
 */
function skillRoots(cwd: string | undefined): SkillRoot[] {
  const roots: SkillRoot[] = []

  // 项目级：只在有工作区时扫描。
  if (cwd !== undefined) {
    roots.push({
      dir: join(findProjectRoot(cwd), SKILLS_DIR),
      source: SOURCE_PROJECT,
      rank: PROJECT_RANK,
    })
  }

  // 用户级：与工作区无关，只要主目录存在就扫描。
  const home = homedir()
  if (home.length > 0) {
    roots.push(
      {
        dir: join(home, USER_SKILLS_DIR),
        source: SOURCE_USER,
        rank: USER_RANK,
      },
      // Costrict 用户级目录。它是一个独立的技能来源，
      // 与 `.claude/skills` 各自独立维护；rank 略低，同名时让位于 `.claude`。
      {
        dir: join(home, COSTRICT_SKILLS_DIR),
        source: SOURCE_COSTRICT,
        rank: COSTRICT_RANK,
      },
    )
  }

  return roots
}

/**
 * 把一个 SKILL.md 拆分为 YAML frontmatter 对象与 Markdown 正文。
 *
 * 纯函数：只接收文本、不触碰文件系统，因此无需夹具即可单元测试。
 * @param raw - 文件原始内容。
 * @returns 解析出的数据与已 trim 的正文；当文件没有 frontmatter 块、
 *   或其中的 YAML 非法时返回 undefined。
 */
function parseFrontmatter(
  raw: string
): { data: Record<string, unknown>; body: string } | undefined {
  // 先把换行统一为 LF。Windows 上编辑的文件用 CRLF，若不复原，
  // `description: xxx` 这类**不带引号的行尾标量**会解析成 "xxx\r"——
  // 多出一个不可见字符，既会进入展示给模型的描述，用户也无从察觉。
  // 引号形式与块标量不受影响，所以这个问题只在 Windows 上以特定写法出现。
  const text = raw.replace(/\r\n?/g, '\n')

  // 技能文件必须以 frontmatter 分隔符开头。
  if (!text.startsWith('---')) return undefined

  // 查找位于行首的分隔符：正文中稍后出现的 Markdown 分隔线或代码围栏
  // 不应被误判为 frontmatter 的结束位置。
  const end = text.indexOf('\n---', 3)
  if (end === -1) return undefined

  const block = text.slice(3, end)
  const body = text.slice(end + 4)

  let data: unknown
  try {
    // 使用真正的 YAML 解析器，而不是逐行正则：描述可能带引号、可能包含冒号，
    // 也可能使用 `>` 或 `|` 这类块标量。
    data = parseYaml(block)
  } catch {
    return undefined
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined
  }
  return { data: data as Record<string, unknown>, body: body.trim() }
}

function optionalBoolean(
  data: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(lowered)) return true
    if (['false', 'no', 'off', '0'].includes(lowered)) return false
  }
  return undefined
}


function parseInvocationPolicy(
  data: Record<string, unknown>,
): SkillInvocationPolicy {
  const disableModelInvocation = optionalBoolean(data, 'disable-model-invocation')
  const userInvocable = optionalBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function stringField(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly content: string
}

function parseSkillText(text: string, source: string, logger: Context['logger']): ParsedSkill | undefined {
  const parsed = parseFrontmatter(text)
  if (parsed === undefined) {
    logger.warn(`[${name}] 已忽略 ${source}：缺少可用的 YAML frontmatter`)
    return undefined
  }

  // 注册表要求这两个路由字段同时存在；缺任意一个，技能都无法被寻址和展示。
  const skillName = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (skillName === undefined || description === undefined) {
    logger.warn(`[${name}] 已忽略 ${source}：frontmatter 需要 name 与 description`)
    return undefined
  }

  // 提前拒绝注册表之后也会拒绝的非法名称，并给出更明确的日志。
  if (!isSkillName(skillName)) {
    logger.warn(`[${name}] 已忽略 ${source}：非法的技能名 "${skillName}"`)
    return undefined
  }

  const whenToUse = stringField(parsed.data, 'whenToUse')

  return {
    name: skillName,
    description,
    // 条件展开：`exactOptionalPropertyTypes` 会区分"键缺失"与"键存在但值为 undefined"。
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation: parseInvocationPolicy(parsed.data),
    content: parsed.body,
  }
}

/* ────────────────────────────── I/O 操作 ───────────────────────────── */

/**
 * 从磁盘读取并解析一个 SKILL.md。
 * @param skillFile - 文件的绝对路径。
 * @param logger - 跳过原因的输出去处。
 * @param signal - 可选的取消信号；在读取前后各检查一次。
 * @returns 解析出的技能；不可读或不可用时返回 undefined。
 */
async function parseSkillFile(
  skillFile: string,
  logger: Context['logger'],
  signal?: AbortSignal,
): Promise<ParsedSkill | undefined> {
  let text: string
  try {
    // 原地读取，不做任何复制：文件始终留在用户放置的位置，
    // 因此用户的修改在下次加载时立刻可见。
    text = await readFile(skillFile, 'utf8')
  } catch {
    // 文件缺失或不可读不是错误，只是这个技能不存在而已。
    return undefined
  }

  // 已被取消的调用方不应继续做后续工作。
  if (signal?.aborted === true) return undefined

  return parseSkillText(text, skillFile, logger)
}

/**
 * 从单个技能目录构造一个候选。
 * @param skillRoot - 技能目录的绝对路径。
 * @param root - 该技能所属的技能根，提供来源与优先级。
 * @param logger - 跳过原因的输出去处。
 * @param signal - 可选的取消信号。
 * @returns 候选对象；该目录中没有可用技能时返回 undefined。
 */
async function candidateFromDir(
  skillRoot: string,
  root: SkillRoot,
  logger: Context['logger'],
  signal?: AbortSignal,
): Promise<SkillCandidate | undefined> {
  const skillFile = join(skillRoot, SKILL_FILE)
  const parsed = await parseSkillFile(skillFile, logger, signal)
  if (parsed === undefined) return undefined

  const locator: ClaudeSkillLocator = { skillFile, skillRoot, source: root.source }

  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    source: root.source,
    // 必须等于本 Provider 的 `name`：注册表会校验该字段，
    // 并在后续 get() 时依据它把请求路由回所属 Provider。
    provider: name,
    rank: root.rank,
    // 对注册表不透明，仅在 get() 中读回。
    locator,
    // 当 Provider 持有真实磁盘文件时提供的绝对路径。
    path: skillFile,
    // 让加载后的正文能解析 ./references/x.md 这类相对引用。
    resourceBase: { kind: 'directory', path: skillRoot },
  }
}

/**
 * 扫描一个技能根下的所有技能包。
 * @param root - 待扫描的技能根。
 * @param logger - 跳过原因的输出去处。
 * @param signal - 可选的取消信号。
 * @returns 该根下所有可用技能的候选；目录不存在时返回空数组。
 */
async function discoverRoot(
  root: SkillRoot,
  logger: Context['logger'],
  signal?: AbortSignal,
): Promise<SkillCandidate[]> {
  const skillsRoot = root.dir

  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    // 目录不存在是"该项目未使用 Claude 技能"的正常情况，
    // 不应作为错误向上暴露。
    return []
  }

  const candidates: SkillCandidate[] = []
  for (const entry of entries) {
    if (signal?.aborted === true) break
    // 只有直接子目录才算候选：散落的 README.md 不算，
    // 并且刻意不递归进入更深层目录。
    if (!entry.isDirectory()) continue

    const candidate = await candidateFromDir(
      join(skillsRoot, entry.name),
      root,
      logger,
      signal,
    )
    // 单个不可用技能绝不能中断整个扫描过程。
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/**
 * 扫描本次查询涉及的全部技能根。
 * @param cwd - 当前工作区目录；缺省时只扫描用户级。
 * @param logger - 跳过原因的输出去处。
 * @param signal - 可选的取消信号。
 * @returns 所有可用技能的候选；各根互不影响，任一目录缺失都不报错。
 */
async function discoverSkills(
  cwd: string | undefined,
  logger: Context['logger'],
  signal?: AbortSignal,
): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = []
  for (const root of skillRoots(cwd)) {
    if (signal?.aborted === true) break
    // 逐个根累加：用户级目录缺失不应影响项目级技能的发现，反之亦然。
    candidates.push(...(await discoverRoot(root, logger, signal)))
  }
  return candidates
}

/**
 * 收窄本 Provider 候选上携带的不透明 locator。
 * 防御性处理：注册表会原样回传它收到的值，但其类型是 `unknown`，
 * 因此这里校验结构而不是直接假定。
 * @param locator - 候选上的 locator。
 * @returns 带类型的 locator；结构不符合预期时返回 undefined。
 */
function readLocator(locator: unknown): ClaudeSkillLocator | undefined {
  if (typeof locator !== 'object' || locator === null) return undefined
  const value = locator as Partial<ClaudeSkillLocator>
  if (
    typeof value.skillFile !== 'string' ||
    typeof value.skillRoot !== 'string' ||
    typeof value.source !== 'string'
  ) {
    return undefined
  }
  return {
    skillFile: value.skillFile,
    skillRoot: value.skillRoot,
    source: value.source,
  }
}

/* ────────────────────────────── 插件入口 ───────────────────────────── */

/**
 * 在 `ctx.skills` 上注册 Claude 项目级技能 Provider。
 * @param ctx - 携带技能注册表的插件上下文。
 */
export function apply(ctx: Context): void {
  const dispose = ctx.skills.registerProvider(
    (control): SkillProvider => ({
      name,

      /**
       * 列出某个工作区下的候选。只返回元数据：该方法在每次读取目录时都会执行，
       * 因此技能正文刻意留到 get() 被调用时才读取。
       */
      async list(options: SkillLookupOptions) {
        const { cwd, signal } = options
        // cwd 缺省时不再直接返回空：用户级技能与工作区无关，仍应被发现。
        const candidates = await discoverSkills(cwd, ctx.logger, signal)

        ctx.logger.info(
          `[${name}] list() cwd=${cwd ?? '(none)'} found=${candidates.length}`,
        )

        // 把已取消的扫描上报为"完整目录"，会让注册表缓存一份不完整的目录；
        // 因此这里显式返回"发现不完整"的观测结果。
        if (control.signal.aborted || signal?.aborted === true) {
          return { candidates, complete: false }
        }
        return candidates
      },

      /**
       * 加载单个技能正文。每次都重新读取文件：注册表从不缓存定义，
       * 用户编辑过的 SKILL.md 必须能被看到。
       */
      async get(
        candidate: SkillCandidate,
        options: SkillLookupOptions,
      ): Promise<SkillDefinition | undefined> {
        const locator = readLocator(candidate.locator)
        if (locator === undefined) return undefined

        const parsed = await parseSkillFile(
          locator.skillFile,
          ctx.logger,
          options.signal,
        )
        // 文件被删除或变得不可解析，意味着该技能不再可加载。
        if (parsed === undefined) return undefined

        // SkillDefinition 继承自 SkillSummary：它不含 `rank` 与 `locator`，
        // 因此这里显式挑选字段，而不是直接展开整个 candidate。
        return {
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          invocation: parsed.invocation,
          source: locator.source,
          provider: name,
          resourceBase: { kind: 'directory', path: locator.skillRoot },
          path: locator.skillFile,
          content: parsed.content,
        }
      },
    }),
  )

  // Cordis 没有公开的 'dispose' 事件；`ctx.effect()` 才是受支持的清理机制。
  // 它返回的 disposer 会在所属 fiber 卸载时执行，
  // 因此卸载插件即自动注销 Provider。
  ctx.effect(() => {
    ctx.logger.info(`[${name}] Provider 已注册`)
    return () => {
      ctx.logger.info(`[${name}] 正在清理；注销 Provider`)
      dispose()
    }
  })
}

export default { apply, name, inject }