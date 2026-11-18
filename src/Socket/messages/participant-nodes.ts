import { Boom } from '@hapi/boom'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationState, SocketConfig } from '../../Types'
import type { SignalRepository } from '../../Types/Signal'
import { writeRandomPadMax16 } from '../../Utils/generics'
import type { ILogger } from '../../Utils/logger'
import { makeKeyedMutex } from '../../Utils/make-mutex'
import { type BinaryNode, jidDecode } from '../../WABinary'

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
		const patchedMessages: RecipientMessage[] | undefined = Array.isArray(patched)
			? (patched as unknown as RecipientMessage[])
			: undefined

		let shouldIncludeDeviceIdentity = false
		const meId = authState.creds.me!.id
		const mePnUser = jidDecode(meId)?.user
		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? jidDecode(meLid)?.user : null
		const encodedMessages = new WeakMap<proto.IMessage, Uint8Array>()
		const encryptRecipient = async (jid: string | undefined, patchedMessage: proto.IMessage) => {
			try {
				if (!jid) return null
				let msgToEncrypt = patchedMessage

				if (dsmMessage) {
					const { user: targetUser } = jidDecode(jid)!
					const isOwnUser = targetUser === mePnUser || (meLidUser && targetUser === meLidUser)
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isOwnUser && !isExactSenderDevice) {
						msgToEncrypt = dsmMessage
						logger?.debug({ jid, targetUser }, 'Using DSM for own device')
					}
				}

				let encoded = encodedMessages.get(msgToEncrypt)
				if (!encoded) {
					encoded = proto.Message.encode(msgToEncrypt).finish()
					encodedMessages.set(msgToEncrypt, encoded)
				}

				const bytes = writeRandomPadMax16(encoded)
				return await encryptionMutex.mutex(jid, async () => {
					const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
					logger?.debug({ jid, enc: type }, 'participant encryption')
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
		}
		const encryptionPromises = patchedMessages
			? patchedMessages.map(({ recipientJid, message }) => encryptRecipient(recipientJid, message))
			: recipientJids.map(jid => encryptRecipient(jid, patched as proto.IMessage))

		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]
		if (recipientJids.length > 0 && nodes.length === 0) throw new Boom('All encryptions failed', { statusCode: 500 })
		return { nodes, shouldIncludeDeviceIdentity }
	}
