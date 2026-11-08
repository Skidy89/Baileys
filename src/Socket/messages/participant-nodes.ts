import { Boom } from '@hapi/boom'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationState, SocketConfig } from '../../Types'
import { encodeWAMessage } from '../../Utils'
import { type BinaryNode, jidDecode } from '../../WABinary'
import type { ILogger } from '../../Utils/logger'
import { makeKeyedMutex } from '../../Utils/make-mutex'
import type { SignalRepository } from '../../Types/Signal'

type Dependencies = {
	patchMessageBeforeSending: SocketConfig['patchMessageBeforeSending']
	authState: AuthenticationState
	signalRepository: SignalRepository
	encryptionMutex: ReturnType<typeof makeKeyedMutex>
	logger?: ILogger
}

type RecipientMessage = { recipientJid?: string; message: proto.IMessage }

export const makeParticipantNodeCreator =
	({ patchMessageBeforeSending, authState, signalRepository, encryptionMutex, logger }: Dependencies) =>
	async (
		recipientJids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
		dsmMessage?: proto.IMessage
	) => {
		if (!recipientJids.length) return { nodes: [] as BinaryNode[], shouldIncludeDeviceIdentity: false }

		const patched = await patchMessageBeforeSending(message, recipientJids)
		const patchedMessages: RecipientMessage[] = Array.isArray(patched)
			? (patched as unknown as RecipientMessage[])
			: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

		let shouldIncludeDeviceIdentity = false
		const meId = authState.creds.me!.id
		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? jidDecode(meLid)?.user : null
		const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
			try {
				if (!jid) return null
				let msgToEncrypt = patchedMessage

				if (dsmMessage) {
					const { user: targetUser } = jidDecode(jid)!
					const { user: ownPnUser } = jidDecode(meId)!
					const isOwnUser = targetUser === ownPnUser || (meLidUser && targetUser === meLidUser)
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isOwnUser && !isExactSenderDevice) {
						msgToEncrypt = dsmMessage
						logger?.debug({ jid, targetUser }, 'Using DSM for own device')
					}
				}

				const bytes = encodeWAMessage(msgToEncrypt)
				return await encryptionMutex.mutex(jid, async () => {
					const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
					if (type === 'pkmsg') shouldIncludeDeviceIdentity = true
					return {
						tag: 'to',
						attrs: { jid },
						content: [{ tag: 'enc', attrs: { v: '2', type, ...(extraAttrs || {}) }, content: ciphertext }]
					}
				})
			} catch (err) {
				logger?.error({ jid, err }, 'Failed to encrypt for recipient')
				return null
			}
		})

		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]
		if (recipientJids.length > 0 && nodes.length === 0) throw new Boom('All encryptions failed', { statusCode: 500 })
		return { nodes, shouldIncludeDeviceIdentity }
	}
