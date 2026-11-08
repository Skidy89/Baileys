import { Boom } from '@hapi/boom'
import type { SocketConfig, WAMessageKey, MessageReceiptType } from '../../Types'
import { aggregateMessageKeysNotFromMe, unixTimestampSeconds } from '../../Utils'
import { type BinaryNode, isLidUser, isPnUser } from '../../WABinary'

type ReceiptDependencies = Pick<SocketConfig, 'logger'> & {
	sendNode: (node: BinaryNode) => Promise<void>
	fetchPrivacySettings: () => Promise<{ [_: string]: string }>
}

export const makeMessageReceipts = ({ logger, sendNode, fetchPrivacySettings }: ReceiptDependencies) => {
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType
	) => {
		if (messageIds.length === 0) throw new Boom('missing ids in receipt')

		const node: BinaryNode = { tag: 'receipt', attrs: { id: messageIds[0]! } }
		if (type === 'read' || type === 'read-self') node.attrs.t = unixTimestampSeconds().toString()

		if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if (participant) node.attrs.participant = participant
		}

		if (type) node.attrs.type = type
		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{ tag: 'list', attrs: {}, content: remainingMessageIds.map(id => ({ tag: 'item', attrs: { id } })) }
			]
		}

		logger?.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		for (const { jid, participant, messageIds } of aggregateMessageKeysNotFromMe(keys)) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	const readMessages = async (keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		await sendReceipts(keys, privacySettings.readreceipts === 'all' ? 'read' : 'read-self')
	}

	return { sendReceipt, sendReceipts, readMessages }
}
