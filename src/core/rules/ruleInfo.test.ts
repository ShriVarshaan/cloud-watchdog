// The settings screen describes rules from src/shared/explain.ts. If a rule
// or a default changes in rules.ts and not there, the screen would show the
// wrong number; this keeps the two in step.

import { describe, expect, it } from 'vitest'
import { KIND_EXPLANATIONS, RULE_INFO } from '../../shared/explain'
import { RESOURCE_KINDS } from '../../shared/types'
import { RULES } from './rules'

describe('rule descriptions', () => {
  it('describe exactly the rules that exist', () => {
    expect(Object.keys(RULE_INFO).sort()).toEqual(RULES.map((rule) => rule.id).sort())
  })

  it.each(RULES.map((rule) => [rule.id, rule] as const))('%s shows its real parameters and defaults', (id, rule) => {
    const shown = Object.fromEntries(Object.entries(RULE_INFO[id]!.params).map(([name, info]) => [name, info.default]))
    expect(shown).toEqual(rule.params)
  })
})

describe('kind explanations', () => {
  it('cover every resource kind', () => {
    expect(Object.keys(KIND_EXPLANATIONS).sort()).toEqual([...RESOURCE_KINDS].sort())
  })
})
