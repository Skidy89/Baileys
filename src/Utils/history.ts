import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { createInflate, inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages/media'

const inflatePromise = promisify(inflate)

export const downloadHistory = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	const inflater = createInflate()
	const chunks: Buffer[] = []
	inflater.on('data', (chunk: Buffer) => chunks.push(chunk))
	await pipeline(stream, inflater)

	const buffer = Buffer.concat(chunks)
	const syncData = proto.HistorySync.decode(buffer)
	return syncData
}

export const processHistoryMessage = (item: proto.IHistorySync, logger?: ILogger) => {
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []
	const lidPnMappings: LIDMapping[] = []

	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())

	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}

	switch (item.syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.displayName || chat.name || chat.username || undefined,
					username: chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const chatId = chat.id!
				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				const shouldExtractPnFromReceipt = isLid && !chat.pnJid
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				}

				const msgs = chat.messages || []
				delete chat.messages
				let pnFromReceipt: string | undefined

				for (const item of msgs) {
					const message = item.message! as WAMessage
					messages.push(message)
					if (shouldExtractPnFromReceipt && !pnFromReceipt && message.key.fromMe && message.userReceipt?.length) {
						const userJid = message.userReceipt[0]?.userJid
						if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) pnFromReceipt = userJid
					}

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}
				if (pnFromReceipt) lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })

				chats.push(chat)
			}

			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	return {
		chats,
		contacts,
		messages,
		lidPnMappings,
		pastParticipants: item.pastParticipants,
		syncType: item.syncType,
		progress: item.progress
	}
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit,
	logger?: ILogger
) => {
	let historyMsg: proto.HistorySync
	const inlinePayload = msg.initialHistBootstrapInlinePayload
	const inlinePayloadSyncTypes = new Set<number>([
		proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
		proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3,
		proto.HistorySync.HistorySyncType.PUSH_NAME,
		proto.HistorySync.HistorySyncType.ON_DEMAND,
		proto.HistorySync.HistorySyncType.RECENT
	])
	if (inlinePayload?.byteLength && inlinePayloadSyncTypes.has(msg.syncType!)) {
		try {
			historyMsg = proto.HistorySync.decode(await inflatePromise(inlinePayload))
		} catch (err) {
			logger?.error(
				{ err, syncType: msg.syncType, payloadByteLength: inlinePayload.byteLength },
				'failed to inflate inline history sync payload'
			)
			throw err
		}
	} else {
		try {
			historyMsg = await downloadHistory(msg, options)
		} catch (err) {
			logger?.error(
				{ err, syncType: msg.syncType, fileLength: msg.fileLength, hasDirectPath: !!msg.directPath },
				'failed to download or inflate history sync payload'
			)
			throw err
		}
	}

	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}
