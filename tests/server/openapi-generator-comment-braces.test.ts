import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * `findMatchingBrace` in the OpenAPI generator tracked quotes but not comments.
 * A line comment containing an apostrophe opened a phantom string literal, so
 * brace matching ran away and reported "no handler source". The caller treats
 * that as an endpoint with no body, and the endpoint silently lost its
 * `requestBody` in the published spec.
 *
 * It surfaced through a performance fix: a comment explaining why a redundant
 * profile switch is skipped contains "the profile's skill tree", and adding it
 * made `PUT /api/hermes/profiles/active` publish without its required `name`
 * body. A code comment changed the API contract on paper, which is exactly the
 * kind of failure that has to be pinned.
 */
const readRoot = (path: string) => readFileSync(path, 'utf8')

describe('the OpenAPI generator parses comments correctly', () => {
  const gen = readRoot('scripts/generate-openapi.mjs')
  const start = gen.indexOf('function findMatchingBrace')
  expect(start).toBeGreaterThan(-1)
  const body = gen.slice(start, gen.indexOf('\n}\n', start))

  it('skips line comments before treating a quote as a string delimiter', () => {
    // A `//` run must be jumped over, otherwise the apostrophe in ordinary prose
    // ("the profile's tree") opens a string that never closes.
    expect(body).toContain("content[i + 1] === '/'")
    // The generator source spells the newline as an escape, so match the
    // literal text rather than an actual newline character.
    expect(body).toContain("indexOf('\\n', i)")
  })

  it('skips block comments too', () => {
    expect(body).toContain("content[i + 1] === '*'")
    expect(body).toContain("indexOf('*/'")
  })

  it('still tracks real string literals and escapes', () => {
    // The comment handling must not replace the existing quote/escape logic.
    expect(body).toContain('quote = ch')
    expect(body).toContain('escaped = true')
    expect(body).toContain('if (ch === quote')
  })

  it('publishes the profile-switch body it always required', () => {
    // The endpoint is registered with a required `name`, and the spec has to
    // keep saying so.
    const spec = JSON.parse(readRoot('docs/openapi.json'))
    const put = spec.paths['/api/hermes/profiles/active']?.put
    expect(put).toBeDefined()
    const schema = put?.requestBody?.content?.['application/json']?.schema
    expect(schema?.properties?.name?.type).toBe('string')
    expect(schema?.required).toContain('name')
  })
})
