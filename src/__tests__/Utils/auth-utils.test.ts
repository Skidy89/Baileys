import { describe, expect, it } from '@jest/globals'
import type { CacheStore, SignalDataSet, SignalKeyStore } from '../../Types'
import { addTransactionCapability, makeCacheableSignalKeyStore } from '../../Utils/auth/utils'

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

describe('cacheable auth key store', () => {
	it('batches large cache writes only after the durable store commits', async () => {
		const persisted = new Map<string, unknown>()
		const cacheValues = new Map<string, unknown>()
		const calls: string[] = []
		const store: SignalKeyStore = {
			get: async (type, ids) =>
				Object.fromEntries(ids.flatMap(id => {
					const value = persisted.get(`${type}:${id}`)
					return value === undefined ? [] : [[id, value]]
				})) as never,
			set: async data => {
				calls.push('store')
				for (const [type, bucket] of Object.entries(data)) {
					for (const [id, value] of Object.entries(bucket || {})) {
						if (value === null) persisted.delete(`${type}:${id}`)
						else persisted.set(`${type}:${id}`, value)
					}
				}
			}
		}
		const cache: CacheStore & { mset: <T>(entries: { key: string; value: T }[]) => void } = {
			get: key => cacheValues.get(key),
			set: (key, value) => {
				calls.push('set')
				cacheValues.set(key, value)
			},
			del: key => cacheValues.delete(key),
			flushAll: () => cacheValues.clear(),
			mset: entries => {
				calls.push('mset')
				for (const { key, value } of entries) cacheValues.set(key, value)
			}
		}
		const keys = makeCacheableSignalKeyStore(store, undefined, cache)
		const ids = Array.from({ length: 32 }, (_, index) => `session-${index}`)
		const sessions = Object.fromEntries(ids.map((id, index) => [id, Uint8Array.from([index])]))

		await keys.set({ session: sessions })

		expect(calls).toEqual(['store', 'mset'])
		expect(await keys.get('session', ids)).toEqual(sessions)
	})
})
