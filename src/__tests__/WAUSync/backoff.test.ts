import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { USyncBackoff } from '../../WAUSync/USyncBackoff'

type Query = Parameters<USyncBackoff['waitFor']>[0]

describe('USyncBackoff', () => {
	afterEach(() => {
		jest.clearAllTimers()
		jest.useRealTimers()
	})

	it('waits for a protocol backoff on background queries', async () => {
		jest.useFakeTimers()
		const query = { context: 'background', protocols: [{ name: 'devices' }] } as unknown as Query
		const backoff = new USyncBackoff()
		backoff.record(query, {
			tag: 'iq', attrs: { type: 'result' }, content: [{
				tag: 'usync', attrs: {}, content: [{
					tag: 'result', attrs: {}, content: [{
						tag: 'devices', attrs: {}, content: [{ tag: 'error', attrs: { backoff: '2' } }]
					}]
				}]
			}]
		})

		let finished = false
		const waiting = backoff.waitFor(query).then(() => { finished = true })
		await jest.advanceTimersByTimeAsync(1999)
		expect(finished).toBe(false)
		await jest.advanceTimersByTimeAsync(1)
		await waiting
		expect(finished).toBe(true)
	})

	it('does not delay interactive queries', async () => {
		jest.useFakeTimers()
		const query = { context: 'interactive', protocols: [{ name: 'devices' }] } as unknown as Query
		const backoff = new USyncBackoff()
		backoff.record({ ...query, context: 'background' }, {
			tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'usync', attrs: {}, content: [{
				tag: 'result', attrs: {}, content: [{ tag: 'devices', attrs: {}, content: [{ tag: 'error', attrs: { backoff: '20' } }] }]
			}]}]
		})

		await expect(backoff.waitFor(query)).resolves.toBeUndefined()
	})
})
