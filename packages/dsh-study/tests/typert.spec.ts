import { describe, expect, it } from 'vitest'
import { TYPERT } from '../generated/typert.host.js'
import { TYPERT_REMOTE } from '../generated/typert.remote-client.js'

describe('generated StudyOS Remote contributions', () => {
  it('publishes the complete dashboard plan workflow on host and client', () => {
    const expected = [
      'overview',
      'selectProject',
      'previewPlan',
      'latestPlan',
      'savePlan',
      'decidePlan',
      'applyPlan',
    ]
    expect(TYPERT.invocations.map(item => item.method)).toEqual(expected)
    expect(TYPERT_REMOTE.descriptors.map(item => item.method)).toEqual(expected)
  })

  it('does not strip newer dashboard fields at the Remote boundary', () => {
    const overview = TYPERT.invocations.find(item => item.method === 'overview')
    expect(overview).toBeDefined()
    const value = {
      vaultPath: '/tmp/vault',
      projects: [],
      dueReviewCount: 0,
      dueReviews: [],
      calendar: { start: '2026-08-01', end: '2026-10-16', days: [] },
    }
    expect(overview?.result.schema.parse(value)).toEqual(value)
  })
})
