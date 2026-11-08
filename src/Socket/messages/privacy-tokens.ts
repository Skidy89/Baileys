import { unixTimestampSeconds } from '../../Utils'
import { type BinaryNode, jidNormalizedUser, S_WHATSAPP_NET } from '../../WABinary'

export const makePrivacyTokenIssuer =
	(query: (node: BinaryNode) => Promise<BinaryNode>) => async (jids: string[], timestamp?: number) => {
		const t = (timestamp ?? unixTimestampSeconds()).toString()
		return query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' },
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: jids.map(jid => ({
						tag: 'token',
						attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' }
					}))
				}
			]
		})
	}
