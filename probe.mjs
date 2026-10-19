import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import plugin, { name as pluginName, inject } from './lib/index.js'

const ctx = new Context()
await ctx.plugin(SkillRegistry)

console.log('registry mounted:', typeof ctx.skills === 'object')
console.log('plugin declares:', pluginName, JSON.stringify(inject))

const fiber = await ctx.plugin(plugin)

const list = await ctx.skills.list({ cwd: '/tmp/anywhere' })
console.log('\nlist() ->', JSON.stringify(list, null, 2))

const def = await ctx.skills.get('skeleton-probe', { cwd: '/tmp/anywhere' })
console.log('\nget() content ->', JSON.stringify(def?.content))

await fiber.dispose()
const after = await ctx.skills.list({ cwd: '/tmp/anywhere' })
console.log('\nafter dispose, list() ->', JSON.stringify(after))

