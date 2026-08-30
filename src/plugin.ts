// @zseven-w/dsh-qa — the loadable Cordis plugin the DSH host activates
// (cordis.patch.yml: id dsh-qa, name '@zseven-w/dsh-qa').
//
// This entry re-exports the full library surface (contracts, session core,
// adapters, replay, reporters, redaction) and adds the plugin shape the host
// needs: name, inject, apply. apply registers the eight qa_* tools on the
// host's tools service and the bundled playbook on the optional skills service
// (ctx.inject(['skills'], …) + fiber.dispose()), then tears everything down on
// dispose. Like dsh-browser and dsh-computer, the plugin never imports
// @deepseek-ai/* — it compiles against a structural host subset only.

export * from './index.ts'
export { createQaTools, qaToolList, QaToolHost, ownerFrom } from './tools.ts'
export type { StructuralToolDefinition, ToolExecutionContext, QaTools } from './tools.ts'
export {
  QA_SKILL_CONTENT,
  QA_SKILL_DESCRIPTION,
  QA_SKILL_NAME,
  QA_SKILL_WHEN_TO_USE,
  registerQaSkill,
} from './skill.ts'
export type { StructuralCordisContext, StructuralSkillContext, StructuralToolsService } from './host.ts'

import { QA_TOOL_NAMES } from './contracts.ts'
import type { StructuralCordisContext } from './host.ts'
import { registerQaSkill } from './skill.ts'
import { createQaTools, qaToolList, QaToolHost } from './tools.ts'

/** Stable plugin name (the loader entry id in cordis.patch.yml). */
export const name = 'dsh-qa'

/** Services this plugin's root fiber requires. */
export const inject = ['tools']

/** Plugin entry: mount every model-facing contribution. */
export function apply(ctx: StructuralCordisContext): () => Promise<void> {
  const host = new QaToolHost()
  const tools = createQaTools(host)

  const disposers: Array<() => void | Promise<void>> = []
  // The bundled playbook (optional skill service): a host without it simply
  // does not advertise the skill. ctx.inject(['skills'], …) is the only safe
  // optional-service form; registerQaSkill tears the fiber down via dispose().
  disposers.push(registerQaSkill(ctx))
  for (const definition of qaToolList(tools)) {
    disposers.push(ctx.effect(() => ctx.tools.register(definition), `dsh-qa:${definition.name}`))
  }
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/disposed', async ({ agent }) => {
      const id = agent?.id
      if (typeof id !== 'string' || id === '') return
      try {
        await host.stopOwner(id)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-qa could not stop Agent scope ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }
  ctx.logger?.info?.(`dsh-qa mounted (${QA_TOOL_NAMES.join(' + ')})`)

  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose()
    await host.dispose()
  }
}
