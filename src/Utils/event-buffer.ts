import EventEmitter from 'events'
import type { proto } from '../../WAProto/index.js'
import type {
	BaileysEvent,
	BaileysEventEmitter,
	BaileysEventMap,
	BufferedEventData,
	Chat,
	ChatUpdate,
	Contact,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStatus } from '../Types'
import { getKeyAuthor, trimUndefined } from './generics'
import type { ILogger } from './logger'
import { updateMessageWithReaction } from './messages'
import { isRealMessage, shouldIncrementChatUnread } from './messages/process'

const BUFFERABLE_EVENT = [
	'messaging-history.set',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'contacts.upsert',
	'contacts.update',
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'messages.reaction',
	'message-receipt.update',
	'groups.update'
] as const

type BufferableEvent = (typeof BUFFERABLE_EVENT)[number]
type BufferableEventEntry = { [E in BufferableEvent]: [event: E, eventData: BaileysEventMap[E]] }[BufferableEvent]

/**
 * A map that contains a list of all events that have been triggered
 *
 * Note, this can contain different type of events
 * this can make processing events extremely efficient -- since everything
 * can be done in a single transaction
 */
type BaileysEventData = Partial<BaileysEventMap>

const BUFFERABLE_EVENT_SET = new Set<BaileysEvent>(BUFFERABLE_EVENT)
const MAX_HISTORY_CACHE_SIZE = 10000
const addHistoryCacheKey = (cache: Set<string>, key: string) => {
	if (cache.size < MAX_HISTORY_CACHE_SIZE) {
		cache.add(key)
		return false
	}

	return !cache.has(key)
}

type BaileysBufferableEventEmitter = BaileysEventEmitter & {
	/** Use to process events in a batch */
	process(handler: (events: BaileysEventData) => void | Promise<void>): () => void
	/**
	 * starts buffering events, call flush() to release them
	 * */
	buffer(): void
	/** buffers all events till the promise completes */
	createBufferedFunction<A extends unknown[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>
	/**
	 * flushes all buffered events
	 * @returns returns true if the flush actually happened, otherwise false
	 */
	flush(): boolean
	/** is there an ongoing buffer */
	isBuffering(): boolean
	/** destroy the event buffer, clearing all resources */
	destroy(): void
}

/**
 * The event buffer logically consolidates different events into a single event
 * making the data processing more efficient.
 */
export const makeEventBuffer = (logger: ILogger | undefined): BaileysBufferableEventEmitter => {
	const ev = new EventEmitter()
	const historyCache = new Set<string>()
	let pastParticipantsByGroup = new Map<string, { entry: proto.IPastParticipants; signatures: Set<string> }>()
	let bufferedReactionIndexes = new WeakMap<object, Set<string>>()
	let bufferedReceiptIndexes = new WeakMap<object, Map<string, proto.IUserReceipt>>()
	let historyCacheOverflowed = false

	let data = makeBufferData()
	let bufferedMessageUpsertType: BufferedEventData['messageUpserts'][string]['type'] | undefined
	let isBuffering = false
	let bufferTimeout: NodeJS.Timeout | null = null
	let flushPendingTimeout: NodeJS.Timeout | null = null // Add a specific timer for the debounced flush to prevent leak
	let bufferCount = 0
	const BUFFER_TIMEOUT_MS = 30000 // 30 seconds

	// take the generic event and fire it as a baileys event
	ev.on('event', (map: BaileysEventData) => {
		for (const event in map) {
			ev.emit(event, map[event as keyof BaileysEventMap])
		}
	})

	function buffer() {
		if (!isBuffering) {
			if (logger) logger.debug('Event buffer activated')
			isBuffering = true
			bufferCount = 0

			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
			}

			bufferTimeout = setTimeout(() => {
				if (isBuffering) {
					if (logger) logger.warn('Buffer timeout reached, auto-flushing')
					flush()
				}
			}, BUFFER_TIMEOUT_MS)
		}

		// Always increment count when requested
		bufferCount++
	}

	function flush() {
		if (!isBuffering) {
			return false
		}

		if (logger) logger.debug({ bufferCount }, 'Flushing event buffer')
		isBuffering = false
		bufferCount = 0

		// Clear timeout
		if (bufferTimeout) {
			clearTimeout(bufferTimeout)
			bufferTimeout = null
		}

		if (flushPendingTimeout) {
			clearTimeout(flushPendingTimeout)
			flushPendingTimeout = null
		}

		if (historyCacheOverflowed || historyCache.size > MAX_HISTORY_CACHE_SIZE) {
			if (logger) logger.debug({ cacheSize: historyCache.size }, 'Clearing history cache')
			historyCache.clear()
			historyCacheOverflowed = false
		}

		const newData = makeBufferData()
		const chatUpdates = Object.values(data.chatUpdates)
		let conditionalChatUpdatesLeft = 0
		for (const update of chatUpdates) {
			if (update.conditional) {
				conditionalChatUpdatesLeft += 1
				newData.chatUpdates[update.id!] = update
				delete data.chatUpdates[update.id!]
			}
		}

		const consolidatedData = consolidateEvents(data)
		if (Object.keys(consolidatedData).length) {
			ev.emit('event', consolidatedData)
		}

		data = newData
		bufferedMessageUpsertType = undefined
		pastParticipantsByGroup.clear()
		bufferedReactionIndexes = new WeakMap()
		bufferedReceiptIndexes = new WeakMap()

		if (logger) {
			logger.trace({ conditionalChatUpdatesLeft }, 'released buffered events')
		}

		return true
	}

	return {
		process(handler) {
			const listener = async (map: BaileysEventData) => {
				await handler(map)
			}

			ev.on('event', listener)
			return () => {
				ev.off('event', listener)
			}
		},
		emit<T extends BaileysEvent>(event: BaileysEvent, evData: BaileysEventMap[T]) {
			// Check if this is a messages.upsert with a different type than what's buffered
			// If so, flush the buffered messages first to avoid type overshadowing
			if (isBuffering && event === 'messages.upsert') {
				const { type, messages } = evData as BaileysEventMap['messages.upsert']
				if (bufferedMessageUpsertType && bufferedMessageUpsertType !== type) {
					const existingUpserts = Object.values(data.messageUpserts)
					if (existingUpserts.length) {
						const bufferedType = bufferedMessageUpsertType
						if (logger)
							logger.debug({ bufferedType, newType: type }, 'messages.upsert type mismatch, emitting buffered messages')
						// Emit the buffered messages with their correct type
						ev.emit('event', {
							'messages.upsert': {
								messages: existingUpserts.map(m => m.message),
								type: bufferedType
							}
						})
						// Clear the message upserts from the buffer
						data.messageUpserts = {}
						bufferedMessageUpsertType = undefined
					}
				}
				if (messages.length) bufferedMessageUpsertType = type
			}

			if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
				if (
					append(
						data,
						historyCache,
						[event as BufferableEvent, evData] as BufferableEventEntry,
						logger,
						pastParticipantsByGroup,
						bufferedReactionIndexes,
						bufferedReceiptIndexes
					)
				) {
					historyCacheOverflowed = true
				}
				return true
			}

			return ev.emit('event', { [event]: evData })
		},
		isBuffering() {
			return isBuffering
		},
		buffer,
		flush,
		createBufferedFunction(work) {
			return async (...args) => {
				buffer()
				try {
					const result = await work(...args)
					// If this is the only buffer, flush after a small delay
					if (bufferCount === 1) {
						setTimeout(() => {
							if (isBuffering && bufferCount === 1) {
								flush()
							}
						}, 100) // Small delay to allow nested buffers
					}

					return result
				} catch (error) {
					throw error
				} finally {
					bufferCount = Math.max(0, bufferCount - 1)
					if (bufferCount === 0) {
						// Only schedule ONE timeout, not 10,000
						if (!flushPendingTimeout) {
							flushPendingTimeout = setTimeout(flush, 100)
						}
					}
				}
			}
		},
		on: (...args) => ev.on(...args),
		off: (...args) => ev.off(...args),
		removeAllListeners: (...args) => ev.removeAllListeners(...args),
		destroy() {
			// Clear buffer timeout
			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
				bufferTimeout = null
			}

			if (flushPendingTimeout) {
				clearTimeout(flushPendingTimeout)
				flushPendingTimeout = null
			}

			// Clear history cache
			historyCache.clear()
			historyCacheOverflowed = false
			pastParticipantsByGroup.clear()
			bufferedReactionIndexes = new WeakMap()
			bufferedReceiptIndexes = new WeakMap()
			// Reset buffer data
			data = makeBufferData()
			isBuffering = false
			bufferCount = 0
			// Remove all listeners
			ev.removeAllListeners()
			if (logger) logger.debug('Event buffer destroyed')
		}
	}
}

const makeBufferData = (): BufferedEventData => {
	return {
		historySets: {
			chats: {},
			messages: {},
			contacts: {},
			isLatest: false,
			empty: true
		},
		chatUpserts: {},
		chatUpdates: {},
		chatDeletes: new Set(),
		contactUpserts: {},
		contactUpdates: {},
		messageUpserts: {},
		messageUpdates: {},
		messageReactions: {},
		messageDeletes: {},
		messageReceipts: {},
		groupUpdates: {}
	}
}

function append(
	data: BufferedEventData,
	historyCache: Set<string>,
	entry: BufferableEventEntry,
	logger: ILogger | undefined,
	pastParticipantsByGroup: Map<string, { entry: proto.IPastParticipants; signatures: Set<string> }>,
	bufferedReactionIndexes: WeakMap<object, Set<string>>,
	bufferedReceiptIndexes: WeakMap<object, Map<string, proto.IUserReceipt>>
): boolean {
	const [event, eventData] = entry
	let historyCacheOverflowed = false

	switch (event) {
		case 'messaging-history.set':
			for (const chat of eventData.chats as Chat[]) {
				const id = chat.id || ''
				const existingChat = data.historySets.chats[id]
				if (existingChat) {
					existingChat.endOfHistoryTransferType = chat.endOfHistoryTransferType
				}

				if (!existingChat && !historyCache.has(id)) {
					data.historySets.chats[id] = chat
					historyCacheOverflowed ||= addHistoryCacheKey(historyCache, id)

					absorbingChatUpdate(chat)
				}
			}

			for (const contact of eventData.contacts as Contact[]) {
				const existingContact = data.historySets.contacts[contact.id]
				if (existingContact) {
					Object.assign(existingContact, trimUndefined(contact))
				} else {
					const historyContactId = `c:${contact.id}`
					const hasAnyName = contact.notify || contact.name || contact.verifiedName
					if (!historyCache.has(historyContactId) || hasAnyName) {
						data.historySets.contacts[contact.id] = contact
						historyCacheOverflowed ||= addHistoryCacheKey(historyCache, historyContactId)
					}
				}
			}

			for (const message of eventData.messages as WAMessage[]) {
				const key = stringifyMessageKey(message.key)
				const existingMsg = data.historySets.messages[key]
				if (!existingMsg && !historyCache.has(key)) {
					data.historySets.messages[key] = message
					historyCacheOverflowed ||= addHistoryCacheKey(historyCache, key)
				}
			}

			data.historySets.empty = false
			data.historySets.syncType = eventData.syncType ?? undefined
			if (eventData.pastParticipants?.length) {
				const sigOf = (p: proto.IPastParticipant) => `${p.userJid || ''}:${p.leaveTs || ''}:${p.leaveReason || ''}`
				for (const entry of eventData.pastParticipants) {
					const key = entry.groupJid ?? JSON.stringify(entry)
					let indexed = pastParticipantsByGroup.get(key)
					if (!indexed) {
						const copy = { ...entry, pastParticipants: [...(entry.pastParticipants || [])] }
						indexed = { entry: copy, signatures: new Set(copy.pastParticipants.map(sigOf)) }
						pastParticipantsByGroup.set(key, indexed)
						const pastParticipants = (data.historySets.pastParticipants ??= [])
						pastParticipants.push(copy)
						continue
					}

					for (const p of entry.pastParticipants || []) {
						const sig = sigOf(p)
						if (!indexed.signatures.has(sig)) {
							indexed.entry.pastParticipants!.push(p)
							indexed.signatures.add(sig)
						}
					}
				}
			}

			data.historySets.progress = eventData.progress
			data.historySets.chunkOrder = eventData.chunkOrder
			data.historySets.peerDataRequestSessionId = eventData.peerDataRequestSessionId ?? undefined
			data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest

			break
		case 'chats.upsert':
			for (const chat of eventData as Chat[]) {
				const id = chat.id || ''
				let upsert = data.chatUpserts[id]
				if (id && !upsert) {
					upsert = data.historySets.chats[id]
					if (upsert) {
						if (logger) logger.debug({ chatId: id }, 'absorbed chat upsert in chat set')
					}
				}

				if (upsert) {
					upsert = concatChats(upsert, chat)
				} else {
					upsert = chat
					data.chatUpserts[id] = upsert
				}

				absorbingChatUpdate(upsert)

				if (data.chatDeletes.has(id)) {
					data.chatDeletes.delete(id)
				}
			}

			break
		case 'chats.update':
			for (const update of eventData as ChatUpdate[]) {
				const chatId = update.id!
				const conditionMatches = update.conditional ? update.conditional(data) : true
				if (conditionMatches) {
					delete update.conditional

					// if there is an existing upsert, merge the update into it
					const upsert = data.historySets.chats[chatId] || data.chatUpserts[chatId]
					if (upsert) {
						concatChats(upsert, update)
					} else {
						// merge the update into the existing update
						const chatUpdate = data.chatUpdates[chatId] || {}
						data.chatUpdates[chatId] = concatChats(chatUpdate, update)
					}
				} else if (conditionMatches === undefined) {
					// condition yet to be fulfilled
					data.chatUpdates[chatId] = update
				}
				// otherwise -- condition not met, update is invalid

				// if the chat has been updated
				// ignore any existing chat delete
				if (data.chatDeletes.has(chatId)) {
					data.chatDeletes.delete(chatId)
				}
			}

			break
		case 'chats.delete':
			for (const chatId of eventData as string[]) {
				if (!data.chatDeletes.has(chatId)) {
					data.chatDeletes.add(chatId)
				}

				// remove any prior updates & upserts
				if (data.chatUpdates[chatId]) {
					delete data.chatUpdates[chatId]
				}

				if (data.chatUpserts[chatId]) {
					delete data.chatUpserts[chatId]
				}

				if (data.historySets.chats[chatId]) {
					delete data.historySets.chats[chatId]
				}
			}

			break
		case 'contacts.upsert':
			for (const contact of eventData as Contact[]) {
				let upsert = data.contactUpserts[contact.id]
				if (!upsert) {
					upsert = data.historySets.contacts[contact.id]
					if (upsert) {
						if (logger) logger.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set')
					}
				}

				if (upsert) {
					upsert = Object.assign(upsert, trimUndefined(contact))
				} else {
					upsert = contact
					data.contactUpserts[contact.id] = upsert
				}

				if (data.contactUpdates[contact.id]) {
					upsert = Object.assign(data.contactUpdates[contact.id]!, trimUndefined(contact)) as Contact
					delete data.contactUpdates[contact.id]
				}
			}

			break
		case 'contacts.update':
			const contactUpdates = eventData as BaileysEventMap['contacts.update']
			for (const update of contactUpdates) {
				const id = update.id!
				// merge into prior upsert
				const upsert = data.historySets.contacts[id] || data.contactUpserts[id]
				if (upsert) {
					Object.assign(upsert, update)
				} else {
					// merge into prior update
					const contactUpdate = data.contactUpdates[id] || {}
					data.contactUpdates[id] = Object.assign(contactUpdate, update)
				}
			}

			break
		case 'messages.upsert':
			const { messages, type } = eventData as BaileysEventMap['messages.upsert']
			for (const message of messages) {
				const key = stringifyMessageKey(message.key)
				let existing = data.messageUpserts[key]?.message
				if (!existing) {
					existing = data.historySets.messages[key]
					if (existing) {
						if (logger) logger.debug({ messageId: key }, 'absorbed message upsert in message set')
					}
				}

				if (existing) {
					message.messageTimestamp = existing.messageTimestamp
				}

				if (data.messageUpdates[key]) {
					if (logger) logger.debug('absorbed prior message update in message upsert')
					if ('userReceipt' in data.messageUpdates[key].update) bufferedReceiptIndexes.delete(message)
					Object.assign(message, data.messageUpdates[key].update)
					delete data.messageUpdates[key]
				}

				if (data.historySets.messages[key]) {
					data.historySets.messages[key] = message
				} else {
					data.messageUpserts[key] = {
						message,
						type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type
					}
				}
			}

			break
		case 'messages.update':
			const msgUpdates = eventData as BaileysEventMap['messages.update']
			for (const { key, update } of msgUpdates) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.historySets.messages[keyStr] || data.messageUpserts[keyStr]?.message
				if (existing) {
					if ('reactions' in update) bufferedReactionIndexes.delete(existing)
					if ('userReceipt' in update) bufferedReceiptIndexes.delete(existing)
					Object.assign(existing, update)
					// if the message was received & read by us
					// the chat counter must have been incremented
					// so we need to decrement it
					if (update.status === WAMessageStatus.READ && !key.fromMe) {
						decrementChatReadCounterIfMsgDidUnread(existing)
					}
				} else {
					const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} }
					Object.assign(msgUpdate.update, update)
					data.messageUpdates[keyStr] = msgUpdate
				}
			}

			break
		case 'messages.delete':
			const deleteData = eventData as BaileysEventMap['messages.delete']
			if ('keys' in deleteData) {
				const { keys } = deleteData
				for (const key of keys) {
					const keyStr = stringifyMessageKey(key)
					if (!data.messageDeletes[keyStr]) {
						data.messageDeletes[keyStr] = key
					}

					if (data.messageUpserts[keyStr]) {
						delete data.messageUpserts[keyStr]
					}

					if (data.messageUpdates[keyStr]) {
						delete data.messageUpdates[keyStr]
					}
				}
			} else {
				// TODO: add support
			}

			break
		case 'messages.reaction':
			const reactions = eventData as BaileysEventMap['messages.reaction']
			for (const { key, reaction } of reactions) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateBufferedReaction(existing.message, reaction, bufferedReactionIndexes)
				} else {
					data.messageReactions[keyStr] = data.messageReactions[keyStr] || { key, reactions: [] }
					updateBufferedReaction(data.messageReactions[keyStr], reaction, bufferedReactionIndexes)
				}
			}

			break
		case 'message-receipt.update':
			const receipts = eventData as BaileysEventMap['message-receipt.update']
			for (const { key, receipt } of receipts) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateBufferedReceipt(existing.message, receipt, bufferedReceiptIndexes)
				} else {
					const buffered = (data.messageReceipts[keyStr] ??= { key, userReceipt: [] })
					updateBufferedReceipt(buffered, receipt, bufferedReceiptIndexes)
				}
			}

			break
		case 'groups.update':
			const groupUpdates = eventData as BaileysEventMap['groups.update']
			for (const update of groupUpdates) {
				const id = update.id!
				const groupUpdate = data.groupUpdates[id] || {}
				if (!data.groupUpdates[id]) {
					data.groupUpdates[id] = Object.assign(groupUpdate, update)
				}
			}

			break
		default:
			throw new Error(`"${event}" cannot be buffered`)
	}

	return historyCacheOverflowed

	function absorbingChatUpdate(existing: Chat) {
		const chatId = existing.id || ''
		const update = data.chatUpdates[chatId]
		if (update) {
			const conditionMatches = update.conditional ? update.conditional(data) : true
			if (conditionMatches) {
				delete update.conditional
				if (logger) logger.debug({ chatId }, 'absorbed chat update in existing chat')
				Object.assign(existing, concatChats(update as Chat, existing))
				delete data.chatUpdates[chatId]
			} else if (conditionMatches === false) {
				if (logger) logger.debug({ chatId }, 'chat update condition fail, removing')
				delete data.chatUpdates[chatId]
			}
		}
	}

	function decrementChatReadCounterIfMsgDidUnread(message: WAMessage) {
		// decrement chat unread counter
		// if the message has already been marked read by us
		const chatId = message.key.remoteJid!
		const chat = data.chatUpdates[chatId] || data.chatUpserts[chatId]
		if (
			isRealMessage(message) &&
			shouldIncrementChatUnread(message) &&
			typeof chat?.unreadCount === 'number' &&
			chat.unreadCount > 0
		) {
			if (logger) logger.debug({ chatId: chat.id }, 'decrementing chat counter')
			chat.unreadCount -= 1
			if (chat.unreadCount === 0) {
				delete chat.unreadCount
			}
		}
	}
}

function consolidateEvents(data: BufferedEventData) {
	const map: BaileysEventData = {}

	if (!data.historySets.empty) {
		map['messaging-history.set'] = {
			chats: Object.values(data.historySets.chats),
			messages: Object.values(data.historySets.messages),
			contacts: Object.values(data.historySets.contacts),
			pastParticipants: data.historySets.pastParticipants,
			syncType: data.historySets.syncType,
			progress: data.historySets.progress,
			isLatest: data.historySets.isLatest,
			chunkOrder: data.historySets.chunkOrder,
			peerDataRequestSessionId: data.historySets.peerDataRequestSessionId
		}
	}

	const chatUpsertList = Object.values(data.chatUpserts)
	if (chatUpsertList.length) {
		map['chats.upsert'] = chatUpsertList
	}

	const chatUpdateList = Object.values(data.chatUpdates)
	if (chatUpdateList.length) {
		map['chats.update'] = chatUpdateList
	}

	const chatDeleteList = Array.from(data.chatDeletes)
	if (chatDeleteList.length) {
		map['chats.delete'] = chatDeleteList
	}

	const messages: WAMessage[] = []
	let messageUpsertType: BaileysEventMap['messages.upsert']['type'] | undefined
	for (const key in data.messageUpserts) {
		const upsert = data.messageUpserts[key]!
		if (!messages.length) messageUpsertType = upsert.type
		messages.push(upsert.message)
	}
	if (messages.length) {
		map['messages.upsert'] = {
			messages,
			type: messageUpsertType!
		}
	}

	const messageUpdateList = Object.values(data.messageUpdates)
	if (messageUpdateList.length) {
		map['messages.update'] = messageUpdateList
	}

	const messageDeleteList = Object.values(data.messageDeletes)
	if (messageDeleteList.length) {
		map['messages.delete'] = { keys: messageDeleteList }
	}

	const messageReactionList: BaileysEventMap['messages.reaction'] = []
	for (const id in data.messageReactions) {
		const { key, reactions } = data.messageReactions[id]!
		for (const reaction of reactions) messageReactionList.push({ key, reaction })
	}
	if (messageReactionList.length) {
		map['messages.reaction'] = messageReactionList
	}

	const messageReceiptList: BaileysEventMap['message-receipt.update'] = []
	for (const id in data.messageReceipts) {
		const { key, userReceipt } = data.messageReceipts[id]!
		for (const receipt of userReceipt) messageReceiptList.push({ key, receipt })
	}
	if (messageReceiptList.length) {
		map['message-receipt.update'] = messageReceiptList
	}

	const contactUpsertList = Object.values(data.contactUpserts)
	if (contactUpsertList.length) {
		map['contacts.upsert'] = contactUpsertList
	}

	const contactUpdateList = Object.values(data.contactUpdates)
	if (contactUpdateList.length) {
		map['contacts.update'] = contactUpdateList
	}

	const groupUpdateList = Object.values(data.groupUpdates)
	if (groupUpdateList.length) {
		map['groups.update'] = groupUpdateList
	}

	return map
}

function concatChats<C extends Partial<Chat>>(a: C, b: Partial<Chat>) {
	if (
		b.unreadCount === null && // neutralize unread counter
		a.unreadCount! < 0
	) {
		a.unreadCount = undefined
		b.unreadCount = undefined
	}

	if (typeof a.unreadCount === 'number' && typeof b.unreadCount === 'number') {
		b = { ...b }
		if (b.unreadCount! >= 0) {
			b.unreadCount = Math.max(b.unreadCount!, 0) + Math.max(a.unreadCount, 0)
		}
	}

	return Object.assign(a, b)
}

const stringifyMessageKey = (key: WAMessageKey) => `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`

const updateBufferedReaction = (
	target: Pick<WAMessage, 'reactions'>,
	reaction: proto.IReaction,
	indexes: WeakMap<object, Set<string>>
) => {
	let authors = indexes.get(target)
	if (!authors) {
		authors = new Set((target.reactions || []).map(existing => getKeyAuthor(existing.key)))
		indexes.set(target, authors)
	}

	const author = getKeyAuthor(reaction.key)
	if (authors.has(author)) {
		updateMessageWithReaction(target, reaction)
	} else {
		reaction.text = reaction.text || ''
		const reactions = target.reactions || (target.reactions = [])
		reactions.push(reaction)
		authors.add(author)
	}
}

const updateBufferedReceipt = (
	target: Pick<WAMessage, 'userReceipt'>,
	receipt: proto.IUserReceipt,
	indexes: WeakMap<object, Map<string, proto.IUserReceipt>>
) => {
	let index = indexes.get(target)
	if (!index) {
		index = new Map()
		for (const existing of target.userReceipt || []) {
			if (!index.has(existing.userJid)) index.set(existing.userJid, existing)
		}
		indexes.set(target, index)
	}

	const existing = index.get(receipt.userJid)
	if (existing) {
		Object.assign(existing, receipt)
	} else {
		const userReceipt = target.userReceipt || (target.userReceipt = [])
		userReceipt.push(receipt)
		index.set(receipt.userJid, receipt)
	}
}
