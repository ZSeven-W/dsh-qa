// Structural cordis host surface for dsh-qa. The host supplies these services
// at runtime; dsh-qa never imports @deepseek-ai/* (that stack is host runtime
// only, documented in the inert dshHostRuntime field), so the plugin compiles
// and ships against this structural subset — exactly like dsh-browser and
// dsh-computer, which define their own StructuralCordisContext inline.

import type { StructuralToolDefinition } from './tools.ts'

export interface StructuralToolsService {
  register(tool: StructuralToolDefinition): () => void
}

export interface StructuralSkillContext {
  skills: {
    register: (skill: {
      name: string
      description: string
      whenToUse?: string
      content: string
      source: string
    }) => () => void
  }
  effect(factory: () => void | (() => void), label?: string): () => void | Promise<void>
}

export interface StructuralCordisContext {
  tools: StructuralToolsService
  effect(
    factory: () => void | (() => void) | Promise<void | (() => void)>,
    label?: string,
  ): () => void | Promise<void>
  inject(
    names: readonly string[],
    callback: (skillCtx: StructuralSkillContext) => void,
  ): { dispose(): void }
  /** Optional same-process host services, resolved lazily (like dsh-computer). */
  get(name: 'attachments' | 'llm' | 'approval'): unknown
  on?(
    event: 'agent/disposed',
    listener: (payload: { agent?: { id?: unknown } }) => void | Promise<void>,
  ): () => void | Promise<void>
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}
