import { describe, expect, it } from '@jest/globals'
import { makeEventBuffer } from '../../Utils/event-buffer'
import type { BaileysEventMap, WAMessage } from '../../Types'
import type { ILogger } from '../../Utils/logger'

describe('event history cache', () => {
	it('merges repeated buffered receipts by user without changing order', () => {
		const ev = makeEventBuffer(undefined)
		const batches: BaileysEventMap['message-receipt.update'][] = []
		const key = { remoteJid: '123@g.us', id: 'message', fromMe: false }
		const updates: BaileysEventMap['message-receipt.update'] = [
			{ key, receipt: { userJid: 'first@s.whatsapp.net', receiptTimestamp: 1 } },
			{ key, receipt: { userJid: 'second@s.whatsapp.net', receiptTimestamp: 2 } },
			{ key, receipt: { userJid: 'first@s.whatsapp.net', readTimestamp: 3 } }
		]
		ev.on('message-receipt.update', update => batches.push(update))

		try {
			ev.buffer()
			ev.emit('message-receipt.update', updates)
			ev.flush()

			expect(batches).toEqual([
				[
					{
						key,
						receipt: { userJid: 'first@s.whatsapp.net', receiptTimestamp: 1, readTimestamp: 3 }
					},
					{ key, receipt: { userJid: 'second@s.whatsapp.net', receiptTimestamp: 2 } }
				]
			])
		} finally {
			ev.destroy()
		}
	})

	it('rebuilds a receipt index when a message update replaces its receipts', () => {
		const ev = makeEventBuffer(undefined)
		const batches: WAMessage[] = []
		const key = { remoteJid: '123@g.us', id: 'message', fromMe: false }
		const message = {
			key,
			messageTimestamp: 1,
			userReceipt: [{ userJid: 'first@s.whatsapp.net', receiptTimestamp: 1 }]
		} as WAMessage
		ev.on('messages.upsert', ({ messages }) => batches.push(...messages))

		try {
			ev.buffer()
			ev.emit('messages.upsert', { messages: [message], type: 'notify' })
			ev.emit('message-receipt.update', [{ key, receipt: { userJid: 'first@s.whatsapp.net', readTimestamp: 2 } }])
			ev.emit('messages.update', [
				{ key, update: { userReceipt: [{ userJid: 'replacement@s.whatsapp.net', receiptTimestamp: 3 }] } }
			])
			ev.emit('message-receipt.update', [{ key, receipt: { userJid: 'replacement@s.whatsapp.net', readTimestamp: 4 } }])
			ev.flush()

			expect(batches[0]?.userReceipt).toEqual([
				{ userJid: 'replacement@s.whatsapp.net', receiptTimestamp: 3, readTimestamp: 4 }
			])
		} finally {
			ev.destroy()
		}
	})

	it('appends new authors in constant time and moves updated reactions to the end', () => {
		const ev = makeEventBuffer(undefined)
		const key = { remoteJid: '123@g.us', id: 'message', fromMe: false }
		const message = { key, messageTimestamp: 1 } as WAMessage
		const reaction = (author: string, id: string, text: string): BaileysEventMap['messages.reaction'][number] => ({
			key,
			reaction: {
				key: { ...key, id, participant: author },
				text,
				groupingKey: '',
				senderTimestampMs: 1,
				unread: false
			}
		})
		const updates = [
			reaction('first@s.whatsapp.net', 'first', '👍'),
			reaction('second@s.whatsapp.net', 'second', '❤️'),
			reaction('first@s.whatsapp.net', 'first-update', '😂')
		]
		const batches: WAMessage[] = []
		ev.on('messages.upsert', ({ messages }) => batches.push(...messages))

		try {
			ev.buffer()
			ev.emit('messages.upsert', { messages: [message], type: 'notify' })
			ev.emit('messages.reaction', updates)
			ev.flush()

			expect(message.reactions).toEqual([updates[1]!.reaction, updates[2]!.reaction])
			expect(batches[0]?.reactions).toEqual(message.reactions)
		} finally {
			ev.destroy()
		}
	})

	it('rebuilds a reaction index when a message update replaces its reactions', () => {
		const ev = makeEventBuffer(undefined)
		const key = { remoteJid: '123@g.us', id: 'message', fromMe: false }
		const message = { key, messageTimestamp: 1 } as WAMessage
		const reaction = (author: string, id: string): BaileysEventMap['messages.reaction'][number] => ({
			key,
			reaction: {
				key: { ...key, id, participant: author },
				text: '👍',
				groupingKey: '',
				senderTimestampMs: 1,
				unread: false
			}
		})

		try {
			ev.buffer()
			ev.emit('messages.upsert', { messages: [message], type: 'notify' })
			ev.emit('messages.reaction', [reaction('first@s.whatsapp.net', 'first')])
			ev.emit('messages.update', [
				{ key, update: { reactions: [reaction('replacement@s.whatsapp.net', 'replacement').reaction] } }
			])
			ev.emit('messages.reaction', [reaction('replacement@s.whatsapp.net', 'replacement-update')])
			ev.flush()

			expect(message.reactions).toEqual([reaction('replacement@s.whatsapp.net', 'replacement-update').reaction])
		} finally {
			ev.destroy()
		}
	})

	it('merges past participants across history chunks without duplicates', () => {
		const ev = makeEventBuffer(undefined)
		const history: Array<unknown> = []
		ev.on('messaging-history.set', update => history.push(update.pastParticipants))
		const firstChunk = {
			groupJid: 'first@g.us',
			pastParticipants: [
				{ userJid: '1@s.whatsapp.net', leaveTs: 1, leaveReason: 0 },
				{ userJid: '2@s.whatsapp.net', leaveTs: 2, leaveReason: 0 }
			]
		}
		const secondChunk = {
			groupJid: 'first@g.us',
			pastParticipants: [
				{ userJid: '2@s.whatsapp.net', leaveTs: 2, leaveReason: 0 },
				{ userJid: '3@s.whatsapp.net', leaveTs: 3, leaveReason: 1 }
			]
		}
		const newGroup = {
			groupJid: 'second@g.us',
			pastParticipants: [{ userJid: '4@s.whatsapp.net', leaveTs: 4, leaveReason: 0 }]
		}

		try {
			ev.buffer()
			ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], pastParticipants: [firstChunk] })
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants: [secondChunk, newGroup]
			})
			ev.flush()

			expect(history).toEqual([
				[
					{
						groupJid: 'first@g.us',
						pastParticipants: [
							{ userJid: '1@s.whatsapp.net', leaveTs: 1, leaveReason: 0 },
							{ userJid: '2@s.whatsapp.net', leaveTs: 2, leaveReason: 0 },
							{ userJid: '3@s.whatsapp.net', leaveTs: 3, leaveReason: 1 }
						]
					},
					{
						groupJid: 'second@g.us',
						pastParticipants: [{ userJid: '4@s.whatsapp.net', leaveTs: 4, leaveReason: 0 }]
					}
				]
			])

			ev.buffer()
			ev.emit('messaging-history.set', {
				chats: [],
				contacts: [],
				messages: [],
				pastParticipants: [
					{
						groupJid: 'first@g.us',
						pastParticipants: [{ userJid: '5@s.whatsapp.net', leaveTs: 5, leaveReason: 0 }]
					}
				]
			})
			ev.flush()
			expect(history[1]).toEqual([
				{
					groupJid: 'first@g.us',
					pastParticipants: [{ userJid: '5@s.whatsapp.net', leaveTs: 5, leaveReason: 0 }]
				}
			])
		} finally {
			ev.destroy()
		}
	})

	it('consolidates reactions and receipts in insertion order', () => {
		const ev = makeEventBuffer(undefined)
		const reactionBatches: BaileysEventMap['messages.reaction'][] = []
		const receiptBatches: BaileysEventMap['message-receipt.update'][] = []
		const messageKey = (id: string) => ({ remoteJid: '123@s.whatsapp.net', id, fromMe: false })
		const reactions: BaileysEventMap['messages.reaction'] = ['first', 'second'].map((id, index) => ({
			key: messageKey(`target-${id}`),
			reaction: {
				key: messageKey(`reaction-${id}`),
				text: id,
				groupingKey: '',
				senderTimestampMs: index,
				unread: false
			}
		}))
		const receipts: BaileysEventMap['message-receipt.update'] = ['first', 'second'].map((id, index) => ({
			key: messageKey(`receipt-${id}`),
			receipt: {
				userJid: `${index}@s.whatsapp.net`,
				receiptTimestamp: index,
				readTimestamp: 0,
				playedTimestamp: 0,
				pendingDeviceJid: [],
				deliveredDeviceJid: []
			}
		}))
		ev.on('messages.reaction', update => reactionBatches.push(update))
		ev.on('message-receipt.update', update => receiptBatches.push(update))

		try {
			ev.buffer()
			ev.emit('messages.reaction', reactions)
			ev.emit('message-receipt.update', receipts)
			ev.flush()

			expect(reactionBatches).toEqual([reactions])
			expect(receiptBatches).toEqual([receipts])
		} finally {
			ev.destroy()
		}
	})

	it('emits buffered message upserts before switching their type', () => {
		const ev = makeEventBuffer(undefined)
		const batches: Array<{ messages: WAMessage[]; type: string }> = []
		const first = {
			key: { remoteJid: '123@s.whatsapp.net', id: 'first', fromMe: false },
			messageTimestamp: 1
		} as WAMessage
		const second = {
			key: { remoteJid: '123@s.whatsapp.net', id: 'second', fromMe: false },
			messageTimestamp: 2
		} as WAMessage
		const third = {
			key: { remoteJid: '123@s.whatsapp.net', id: 'third', fromMe: false },
			messageTimestamp: 3
		} as WAMessage
		ev.on('messages.upsert', update => batches.push(update))

		try {
			ev.buffer()
			ev.emit('messages.upsert', { messages: [first], type: 'notify' })
			ev.emit('messages.upsert', { messages: [second], type: 'notify' })
			expect(batches).toHaveLength(0)

			ev.emit('messages.upsert', { messages: [third], type: 'append' })
			expect(batches).toEqual([{ messages: [first, second], type: 'notify' }])

			ev.flush()
			expect(batches).toEqual([
				{ messages: [first, second], type: 'notify' },
				{ messages: [third], type: 'append' }
			])
		} finally {
			ev.destroy()
		}
	})

	it('keeps deduplication at the limit and clears it after overflow', () => {
		const debugLogs: unknown[][] = []
		const logger: ILogger = {
			level: 'silent',
			child: () => logger,
			trace: () => {},
			debug: (obj, msg) => debugLogs.push([obj, msg]),
			info: () => {},
			warn: () => {},
			error: () => {}
		}
		const ev = makeEventBuffer(logger)
		const batches: WAMessage[][] = []
		ev.on('messaging-history.set', ({ messages }) => batches.push(messages))
		const messages = Array.from({ length: 10000 }, (_, i) => ({
			key: { remoteJid: '123@s.whatsapp.net', id: `message-${i}`, fromMe: false },
			messageTimestamp: 1
		}))
		const flushHistory = (items: WAMessage[]) => {
			ev.buffer()
			ev.emit('messaging-history.set', { chats: [], contacts: [], messages: items })
			ev.flush()
		}

		try {
			flushHistory(messages)
			expect(batches[0]).toHaveLength(10000)

			flushHistory([messages[0]!])
			expect(batches[1]).toHaveLength(0)

			flushHistory([{ key: { remoteJid: '123@s.whatsapp.net', id: 'overflow', fromMe: false }, messageTimestamp: 1 }])
			expect(batches[2]).toHaveLength(1)
			expect(debugLogs).toContainEqual([{ cacheSize: 10000 }, 'Clearing history cache'])

			flushHistory([messages[0]!])
			expect(batches[3]).toHaveLength(1)
		} finally {
			ev.destroy()
		}
	})
})
