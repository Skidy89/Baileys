import { describe, expect, it, jest } from '@jest/globals'
import type { AuthenticationState, PossiblyExtendedCacheStore } from '../../Types'
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal'
import { makeMutex } from '../../Utils/make-mutex'
import { makeDeviceResolver } from '../../Socket/messages/devices'

describe('device resolver cache reads', () => {
	it('returns a direct device for Meta AI without a USync lookup', async () => {
		const executeUSyncQuery = jest.fn()
		const { getUSyncDevices } = makeDeviceResolver({
			authState: { creds: { me: { id: '999@s.whatsapp.net', lid: '999@lid' } } } as AuthenticationState,
			userDevicesCache: { mget: async () => ({}) } as unknown as PossiblyExtendedCacheStore,
			devicesMutex: makeMutex(),
			signalRepository: {} as SignalRepositoryWithLIDStore,
			assertSessions: async () => true,
			executeUSyncQuery
		})

		const devices = await getUSyncDevices(['123@bot'], true, false)

		expect(devices).toEqual([{ user: '123', device: 0, jid: '123@bot' }])
		expect(executeUSyncQuery).not.toHaveBeenCalled()
	})

	it('normalizes USync inputs from the existing JID parse', async () => {
		let queriedUsers: string[] = []
		const { getUSyncDevices } = makeDeviceResolver({
			authState: { creds: { me: { id: '999@s.whatsapp.net', lid: '999@lid' } } } as AuthenticationState,
			userDevicesCache: { mget: async () => ({}) } as unknown as PossiblyExtendedCacheStore,
			devicesMutex: makeMutex(),
			signalRepository: {} as SignalRepositoryWithLIDStore,
			assertSessions: async () => true,
			executeUSyncQuery: async query => {
				queriedUsers = query.users.map(user => user.id!)
				return { list: [], sideList: [] }
			}
		})

		await getUSyncDevices(['123_5@c.us'], true, false)

		expect(queriedUsers).toEqual(['123@s.whatsapp.net'])
	})

	it('reads each cache key once while preserving repeated input JIDs', async () => {
		const get = jest.fn(async (user: string) => [{ user, server: 's.whatsapp.net', device: 1 }])
		const { getUSyncDevices } = makeDeviceResolver({
			authState: {} as AuthenticationState,
			userDevicesCache: { get } as unknown as PossiblyExtendedCacheStore,
			devicesMutex: makeMutex(),
			signalRepository: {} as SignalRepositoryWithLIDStore,
			assertSessions: async () => true,
			executeUSyncQuery: async () => undefined
		})

		const devices = await getUSyncDevices(['111@s.whatsapp.net', '111@lid', '222@s.whatsapp.net'], true, false)

		expect(get).toHaveBeenCalledTimes(2)
		expect(devices.map(({ jid }) => jid)).toEqual([
			'111:1@s.whatsapp.net',
			'111:1@s.whatsapp.net',
			'222:1@s.whatsapp.net'
		])
	})

	it('looks up users concurrently when a cache has no multi-get method', async () => {
		let active = 0
		let maxActive = 0
		const userDevicesCache = {
			get: async (user: string) => {
				active++
				maxActive = Math.max(active, maxActive)
				await new Promise(resolve => setTimeout(resolve, 5))
				active--
				return [{ user, server: 's.whatsapp.net', device: 1 }]
			}
		} as unknown as PossiblyExtendedCacheStore
		const executeUSyncQuery = jest.fn(async () => undefined)
		const { getUSyncDevices } = makeDeviceResolver({
			authState: {} as AuthenticationState,
			userDevicesCache,
			devicesMutex: makeMutex(),
			signalRepository: {} as SignalRepositoryWithLIDStore,
			assertSessions: async () => true,
			executeUSyncQuery
		})

		const devices = await getUSyncDevices(
			['111@s.whatsapp.net', '222@s.whatsapp.net', '333@s.whatsapp.net'],
			true,
			false
		)

		expect(maxActive).toBeGreaterThan(1)
		expect(devices.map(({ jid }) => jid)).toEqual([
			'111:1@s.whatsapp.net',
			'222:1@s.whatsapp.net',
			'333:1@s.whatsapp.net'
		])
		expect(executeUSyncQuery).not.toHaveBeenCalled()
	})
})
