import type { AuthenticationState, PossiblyExtendedCacheStore } from '../../Types'
import type NodeCache from '@cacheable/node-cache'
import type { USyncQueryResult } from '../../WAUSync/USyncQuery'
import { USyncQuery, USyncUser } from '../../WAUSync'
import { extractDeviceJids } from '../../Utils'
import {
	type FullJid,
	isHostedLidUser,
	isLidUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	type JidWithDevice
} from '../../WABinary'
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal'
import type { Mutex } from '../../Utils/make-mutex'
import type { ILogger } from '../../Utils/logger'

export type DeviceWithJid = JidWithDevice & { jid: string }
type DeviceCache = NodeCache<JidWithDevice[]> | PossiblyExtendedCacheStore

type Dependencies = {
	authState: AuthenticationState
	userDevicesCache: DeviceCache
	devicesMutex: Mutex
	signalRepository: SignalRepositoryWithLIDStore
	assertSessions: (jids: string[], force?: boolean) => Promise<boolean>
	executeUSyncQuery: (query: USyncQuery) => Promise<USyncQueryResult | undefined>
	logger?: ILogger
}

export const makeDeviceResolver = (dependencies: Dependencies) => {
	const { authState, userDevicesCache, devicesMutex, signalRepository, assertSessions, executeUSyncQuery, logger } =
		dependencies

	const getUSyncDevices = async (
		jids: string[],
		useCache: boolean,
		ignoreZeroDevices: boolean
	): Promise<DeviceWithJid[]> => {
		const deviceResults: DeviceWithJid[] = []

		if (!useCache) {
			if (logger) logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []

		const jidsWithUser = jids
			.map(jid => {
				const decoded = jidDecode(jid)
				const user = decoded?.user
				const device = decoded?.device
				const isExplicitDevice = typeof device === 'number' && device >= 0

				if (isExplicitDevice && user) {
					deviceResults.push({
						user,
						device,
						jid
					})
					return null
				}

				jid = jidNormalizedUser(jid)
				return { jid, user }
			})
			.filter(jid => jid !== null)

		let mgetDevices: undefined | Record<string, FullJid[] | undefined>

		if (useCache && userDevicesCache.mget) {
			const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean) as string[]
			mgetDevices = await userDevicesCache.mget<FullJid[]>(usersToFetch)
		}

		for (const { jid, user } of jidsWithUser) {
			if (useCache) {
				const devices =
					mgetDevices?.[user!] ||
					(userDevicesCache.mget ? undefined : ((await userDevicesCache.get<FullJid[]>(user!)) as FullJid[]))
				if (devices) {
					const devicesWithJid = devices.map(d => ({
						...d,
						jid: jidEncode(d.user, d.server, d.device)
					}))
					deviceResults.push(...devicesWithJid)
					if (logger) logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if (!toFetch.length) {
			return deviceResults
		}

		const requestedLidUsers = new Set<string>()
		for (const jid of toFetch) {
			if (isLidUser(jid) || isHostedLidUser(jid)) {
				const user = jidDecode(jid)?.user
				if (user) requestedLidUsers.add(user)
			}
		}

		const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()

		for (const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
		}

		const result = await executeUSyncQuery(query)

		if (result) {
			// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
			const lidResults = result.list.filter(a => !!a.lid)
			if (lidResults.length > 0) {
				if (logger) logger.trace('Storing LID maps from device call')
				await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid as string, pn: a.id })))

				// Force-refresh sessions for newly mapped LIDs to align identity addressing
				try {
					const lids = lidResults.map(a => a.lid as string)
					if (lids.length) {
						await assertSessions(lids, true)
					}
				} catch (e) {
					if (logger) logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
				}
			}

			const extracted = extractDeviceJids(
				result?.list,
				authState.creds.me!.id,
				authState.creds.me!.lid!,
				ignoreZeroDevices
			)
			const deviceMap: { [_: string]: FullJid[] } = {}

			for (const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user]?.push(item)
			}

			// Process each user's devices as a group for bulk LID migration
			for (const [user, userDevices] of Object.entries(deviceMap)) {
				const isLidUser = requestedLidUsers.has(user)

				// Process all devices for this user
				for (const item of userDevices) {
					const finalJid = isLidUser
						? jidEncode(user, item.server, item.device)
						: jidEncode(item.user, item.server, item.device)

					deviceResults.push({
						...item,
						jid: finalJid
					})
					if (logger)
						logger.debug(
							{
								user: item.user,
								device: item.device,
								finalJid,
								usedLid: isLidUser
							},
							'Processed device with LID priority'
						)
				}
			}

			await devicesMutex.mutex(async () => {
				if (userDevicesCache.mset) {
					// if the cache supports mset, we can set all devices in one go
					await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
				} else {
					for (const key in deviceMap) {
						if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
					}
				}
			})

			const userDeviceUpdates: { [userId: string]: string[] } = {}
			for (const [userId, devices] of Object.entries(deviceMap)) {
				if (devices && devices.length > 0) {
					userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
				}
			}

			if (Object.keys(userDeviceUpdates).length > 0) {
				try {
					await authState.keys.set({ 'device-list': userDeviceUpdates })
					if (logger)
						logger.debug(
							{ userCount: Object.keys(userDeviceUpdates).length },
							'stored user device lists for bulk migration'
						)
				} catch (error) {
					if (logger) logger.warn({ error }, 'failed to store user device lists')
				}
			}
		}

		return deviceResults
	}
	return { getUSyncDevices }
}
