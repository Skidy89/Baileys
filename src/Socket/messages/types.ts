import type { proto } from '../../../WAProto/index.js'
import { normalizeMessageContent } from '../../Utils'

export const getMessageType = (message: proto.IMessage) => {
	const normalizedMessage = normalizeMessageContent(message)
	if (!normalizedMessage) return 'text'

	if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) return 'reaction'

	if (
		normalizedMessage.pollCreationMessage ||
		normalizedMessage.pollCreationMessageV2 ||
		normalizedMessage.pollCreationMessageV3 ||
		normalizedMessage.pollUpdateMessage
	) {
		return 'poll'
	}

	if (normalizedMessage.eventMessage) return 'event'
	if (getMediaType(normalizedMessage) !== '') return 'media'
	return 'text'
}

export const getMediaType = (message: proto.IMessage) => {
	if (message.imageMessage) return 'image'
	if (message.videoMessage) return message.videoMessage.gifPlayback ? 'gif' : 'video'
	if (message.audioMessage) return message.audioMessage.ptt ? 'ptt' : 'audio'
	if (message.contactMessage) return 'vcard'
	if (message.documentMessage) return 'document'
	if (message.contactsArrayMessage) return 'contact_array'
	if (message.liveLocationMessage) return 'livelocation'
	if (message.stickerMessage) return message.stickerMessage.isAiSticker ? 'genai_sticker' : 'sticker'
	if (message.stickerPackMessage) return 'sticker_pack'
	if (message.listMessage) return 'list'
	if (message.listResponseMessage) return 'list_response'
	if (message.buttonsResponseMessage) return 'buttons_response'
	if (message.orderMessage) return 'order'
	if (message.productMessage) return 'product'
	if (message.interactiveResponseMessage) return 'native_flow_response'
	if (message.groupInviteMessage) return 'url'
	return ''
}
