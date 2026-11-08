import { Boom } from '@hapi/boom'
import { proto } from '../../../WAProto/index.js'
import type { MessageRelayOptions } from '../../Types'
import { unixTimestampSeconds } from '../../Utils'
import { jidNormalizedUser } from '../../WABinary'

type RelayMessage = (jid: string, message: proto.IMessage, options: MessageRelayOptions) => Promise<string>

export const makeMessageOperations = (getMeId: () => string | undefined, relayMessage: RelayMessage) => {
	const updateMemberLabel = (jid: string, memberLabel: string) =>
		relayMessage(
			jid,
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: { label: memberLabel?.slice(0, 30), labelTimestamp: unixTimestampSeconds() }
				}
			},
			{
				additionalNodes: [
					{ tag: 'meta', attrs: { tag_reason: 'user_update', appdata: 'member_tag' }, content: undefined }
				]
			}
		)

	const sendPeerDataOperationMessage = async (
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		const meId = getMeId()
		if (!meId) throw new Boom('Not authenticated')

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		return relayMessage(jidNormalizedUser(meId), protocolMessage, {
			additionalAttributes: { category: 'peer', push_priority: 'high_force' },
			additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }]
		})
	}

	return { updateMemberLabel, sendPeerDataOperationMessage }
}
