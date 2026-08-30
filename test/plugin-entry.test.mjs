// Plugin entry tests: the Cordis plugin shape the host activates (name / apply /
// inject), the optional skill-service registration via ctx.inject(['skills'],
// …) + fiber.dispose(), the StructuralToolDefinition shape every tool must
// carry, and the fact that the committed lib/index.js bundle exposes the same
// shape plus the library surface.
//
// These use a fake structural ctx so the real cordis lifecycle is unit-tested
// without booting the host. They do NOT replace the host boot (see
// scripts/smoke-bundle.mjs and smoke-pack.mjs for the shipped-artifact load).

import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply } from '../src/plugin.ts'
import { QA_TOOL_NAMES } from '../src/contracts.ts'

const QA_TOOL_NAMES_SORTED = QA_TOOL_NAMES.slice().sort()

function makeFakeCtx({ withSkills = false } = {}) {
  const state = {
    registered: [],
    effectLabels: [],
    disposers: [],
    registeredSkills: [],
  }
  const ctx = {
    tools: {
      register(tool) {
        state.registered.push(tool)
        return () => state.disposers.push('tool:' + tool.name)
      },
    },
    effect(factory, label) {
      factory()
      state.effectLabels.push(label)
      return () => state.disposers.push('effect:' + label)
    },
    inject(names, callback) {
      if (withSkills && names.includes('skills')) {
        const skillCtx = {
          skills: {
            register(skill) {
              state.registeredSkills.push(skill)
              return () => state.disposers.push('skill:' + skill.name)
            },
          },
          effect(factory, label) {
            factory()
            return () => state.disposers.push('skill-effect:' + label)
          },
        }
        callback(skillCtx)
      }
      return { dispose: () => state.disposers.push('fiber:dispose') }
    },
    on(event, _listener) {
      return () => state.disposers.push('on:' + event)
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, state }
}

test('plugin entry exports the Cordis shape the host activates', () => {
  assert.equal(name, 'dsh-qa')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('tools'))
  assert.equal(typeof apply, 'function')
})

test('apply registers all eight qa_* tools and returns a disposer', () => {
  const { ctx, state } = makeFakeCtx()
  const dispose = apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(state.registered.map((t) => t.name).sort(), QA_TOOL_NAMES_SORTED)
})

test('apply tears down tools, the agent/disposed hook, and the skill fiber', async () => {
  const { ctx, state } = makeFakeCtx({ withSkills: true })
  const dispose = apply(ctx)
  await dispose()
  for (const toolName of QA_TOOL_NAMES) {
    assert.ok(state.disposers.includes('effect:dsh-qa:' + toolName), 'missing tool teardown ' + toolName)
  }
  assert.ok(state.disposers.includes('on:agent/disposed'))
  assert.ok(state.disposers.includes('fiber:dispose'), 'skill fiber must be torn down via fiber.dispose()')
})

test('skills service present: the QA playbook is registered once via ctx.inject', () => {
  const { ctx, state } = makeFakeCtx({ withSkills: true })
  apply(ctx)
  assert.equal(state.registeredSkills.length, 1)
  const skill = state.registeredSkills[0]
  assert.equal(skill.name, 'qa-orchestration')
  assert.equal(skill.source, 'bundled')
  assert.ok(skill.description.length > 0)
  assert.ok(skill.content.length > 0)
})

test('skills service absent: apply still mounts the tools without throwing', () => {
  const { ctx, state } = makeFakeCtx({ withSkills: false })
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(state.registeredSkills.length, 0)
  assert.equal(state.registered.length, QA_TOOL_NAMES.length)
})

test('every registered tool carries the StructuralToolDefinition shape the host requires', () => {
  const { ctx, state } = makeFakeCtx()
  apply(ctx)
  for (const tool of state.registered) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.output, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
    assert.equal(typeof tool.isConcurrencySafe, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.presentCall, 'function')
  }
})

test('the committed lib/index.js bundle exposes the same entry + library surface', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-qa')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'))
  assert.equal(typeof mod.QaSession, 'function')
  assert.equal(typeof mod.toLosslessJson, 'function')
  assert.equal(typeof mod.createQaTools, 'function')
  assert.equal(typeof mod.runScenario, 'function')
})
