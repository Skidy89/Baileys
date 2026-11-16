import { SessionRecord } from '@skidy89/signal-protocol'
import type { SignalAuthState } from '../../Types'
import { makeLibSignalRepository } from '../../Signal/libsignal'

describe('Signal repository buffers', () => {
	it('returns the session base key buffer without copying it', async () => {
		const baseKey = Buffer.from([0, 1, 2]).subarray(1)
		const prototype = SessionRecord.prototype as unknown as {
			getOpenSession?: () => { indexInfo: { baseKey: Buffer }; registrationId: number }
		}
		const originalGetOpenSession = prototype.getOpenSession
		prototype.getOpenSession = () => ({ indexInfo: { baseKey }, registrationId: 7 })

		try {
			const keys = {
				get: async (type: string) => (type === 'session' ? { '123.0': Buffer.from([1]) } : {}),
				set: async () => {},
				isInTransaction: () => false,
				transaction: async (work: () => Promise<unknown>) => work(),
				transactWith: async (_scope: unknown, work: () => Promise<unknown>) => work()
			}
			const repo = makeLibSignalRepository({ creds: {}, keys } as unknown as SignalAuthState, undefined)

			const result = await (repo as unknown as { getSessionInfo(jid: string): Promise<{ baseKey: Uint8Array } | null> })
				.getSessionInfo('123@s.whatsapp.net')

			expect(result?.baseKey).toBe(baseKey)
			repo.close?.()
		} finally {
			if (originalGetOpenSession) prototype.getOpenSession = originalGetOpenSession
			else delete prototype.getOpenSession
		}
	})
})
