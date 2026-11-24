import { describe, expect, it } from '@jest/globals'
import type { SignalDataSet, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth/utils'

const makeKeys = () => {
	const values = new Map<string, unknown>()
	const state: SignalKeyStore = {
		get: async (type, ids) =>
			Object.fromEntries(
				ids.flatMap(id => {
					const value = values.get(`${type}:${id}`)
					return value === undefined ? [] : [[id, value]]
				})
			) as never,
		set: async (data: SignalDataSet) => {
			for (const [type, bucket] of Object.entries(data)) {
				for (const [id, value] of Object.entries(bucket || {})) {
					if (value === null) values.delete(`${type}:${id}`)
					else values.set(`${type}:${id}`, value)
				}
			}
		}
	}
	return addTransactionCapability(state, undefined, { maxCommitRetries: 1, delayBetweenTriesMs: 0 })
}

describe('auth key store transactions', () => {
	it('persists a detached write after its transaction commits', async () => {
		const keys = makeKeys()
		let finishWrite!: () => void
		const detachedWrite = new Promise<void>(resolve => (finishWrite = resolve))

		await keys.transaction(async () => {
			setTimeout(() => {
				void keys.set({ tctoken: { 'contact@lid': { token: Buffer.from('token') } } }).then(finishWrite)
			}, 0)
		}, 'tctoken-test')
		await detachedWrite

		expect(await keys.get('tctoken', ['contact@lid'])).toEqual({
			'contact@lid': { token: Buffer.from('token') }
		})
	})

	it('ignores a detached write after its transaction rolls back', async () => {
		const keys = makeKeys()
		let finishWrite!: () => void
		const detachedWrite = new Promise<void>(resolve => (finishWrite = resolve))

		await expect(
			keys.transaction(async () => {
				setTimeout(() => {
					void keys.set({ tctoken: { 'contact@lid': { token: Buffer.from('token') } } }).then(finishWrite)
				}, 0)
				throw new Error('rollback')
			}, 'tctoken-test')
		).rejects.toThrow('rollback')
		await detachedWrite

		expect(await keys.get('tctoken', ['contact@lid'])).toEqual({})
	})
})
