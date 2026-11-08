import { parseAndInjectE2ESessions } from '../../Utils'
import { type BinaryNode, isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, S_WHATSAPP_NET } from '../../WABinary'
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal'
import type { ILogger } from '../../Utils/logger'

type Dependencies = {
	query: (node: BinaryNode) => Promise<BinaryNode>
	signalRepository: SignalRepositoryWithLIDStore
	logger?: ILogger
}

export const makeSessionManager = ({ query, signalRepository, logger }: Dependencies) => {
	const assertSessions = async (jids: string[], force?: boolean) => {
		let didFetchNewSession = false
		const uniqueJids = [...new Set(jids)]
		const jidsRequiringFetch: string[] = []
		logger?.debug({ jids }, 'assertSessions call with jids')

		for (const jid of uniqueJids) {
			if (!force) {
				const sessionValidation = await signalRepository.validateSession(jid)
				if (sessionValidation.exists) continue
			}

			jidsRequiringFetch.push(jid)
		}

		if (jidsRequiringFetch.length) {
			const wireJids = [
				...jidsRequiringFetch.filter(jid => isLidUser(jid) || isHostedLidUser(jid)),
				...(
					(await signalRepository.lidMapping.getLIDsForPNs(
						jidsRequiringFetch.filter(jid => isPnUser(jid) || isHostedPnUser(jid))
					)) || []
				).map(a => a.lid)
			]
			logger?.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
				content: [
					{
						tag: 'key',
						attrs: {},
						content: wireJids.map(jid => {
							const attrs: { [key: string]: string } = { jid }
							if (force) attrs.reason = 'identity'
							return { tag: 'user', attrs }
						})
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)
			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	return { assertSessions }
}
