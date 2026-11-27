import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from '@jest/globals'
import { useSqliteAuthState } from '../../Utils/auth/sqlite'

describe('SQLite auth state', () => {
	it('loads large session batches with the original session values', async () => {
		const database = new Database(':memory:')
		const { state, close } = await useSqliteAuthState({ dbPath: ':memory:', database })
		const ids = Array.from({ length: 512 }, (_, index) => `session-${index}`)
		const sessions = Object.fromEntries(ids.map(id => [id, Uint8Array.from([1, 2, 3])]))
		await state.keys.set({ session: sessions })

		try {
			const result = await state.keys.get('session', ids)
			expect(Object.keys(result)).toHaveLength(ids.length)
			expect(result['session-511']).toEqual(Uint8Array.from([1, 2, 3]))
		} finally {
			close()
		}
	})

	it('reopens existing credentials and session records without migration', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'baileys-sqlite-auth-'))
		const dbPath = join(directory, 'auth.db')
		try {
			const first = await useSqliteAuthState({ dbPath })
			first.state.creds.registrationId = 1234
			await first.state.keys.set({ session: { 'contact.0': Uint8Array.from([4, 5, 6]) } })
			await first.saveCreds()
			first.close()

			const reopened = await useSqliteAuthState({ dbPath })
			try {
				expect(reopened.state.creds.registrationId).toBe(1234)
				expect(await reopened.state.keys.get('session', ['contact.0'])).toEqual({
					'contact.0': Uint8Array.from([4, 5, 6])
				})
			} finally {
				reopened.close()
			}
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
