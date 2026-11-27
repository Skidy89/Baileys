import $protobuf from 'protobufjs/minimal.js'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { deflateSync } from 'zlib'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import { encryptedStream } from '../../Utils/messages/media/upload'
import {
	decodeGroupHistoryMessages,
	addProcessedGroupHistoryBundle,
	downloadAndProcessGroupHistoryBundle,
	isGroupHistoryBundleWithinWindow,
	isGroupHistoryMessageWithinWindow,
	isSupportedGroupHistoryMessage,
	isValidGroupHistoryBundle,
	isGroupHistoryRecipient,
	matchesGroupHistoryPlaintextHash
} from '../../Utils/history'

describe('decodeGroupHistoryMessages', () => {
	it('downloads and decrypts with the Group History media type', async () => {
		const groupJid = '456@g.us'
		const recipientJid = '123@s.whatsapp.net'
		const messageBytes = proto.WebMessageInfo.encode({
			key: { remoteJid: groupJid, id: 'history-message' },
			message: { conversation: 'history payload' }
		}).finish()
		const compressed = deflateSync(Buffer.from($protobuf.Writer.create().uint32(10).bytes(messageBytes).finish()))
		const encrypted = await encryptedStream(compressed, 'group-history')
		const fetchSpy = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(readFileSync(encrypted.encFilePath)))
		const now = Math.floor(Date.now() / 1000)
		const message = {
			key: { remoteJid: groupJid, id: 'bundle', fromMe: false },
			messageTimestamp: now,
			message: {
				messageHistoryBundle: {
					mimetype: 'application/protobuf',
					fileSha256: encrypted.fileSha256,
					fileEncSha256: encrypted.fileEncSha256,
					mediaKey: encrypted.mediaKey,
					directPath: '/bundle',
					messageHistoryMetadata: {
						historyReceivers: [recipientJid],
						oldestMessageTimestampInWindow: now - 1,
						messageCount: 1
					}
				}
			}
		} as WAMessage

		try {
			const result = await downloadAndProcessGroupHistoryBundle(message, [recipientJid], {})
			expect(result).toMatchObject({ processed: true, messages: [{ message: { conversation: 'history payload' } }] })
		} finally {
			fetchSpy.mockRestore()
			await unlink(encrypted.encFilePath)
		}
	})

	it('verifies the bundle plaintext hash', () => {
		const data = Buffer.from('compressed bundle bytes')
		const hash = createHash('sha256').update(data).digest()
		expect(matchesGroupHistoryPlaintextHash(hash, hash)).toBe(true)
		expect(matchesGroupHistoryPlaintextHash(hash, new Uint8Array(32))).toBe(false)
		expect(matchesGroupHistoryPlaintextHash(hash, new Uint8Array(31))).toBe(false)
	})

	it('validates mandatory bundle metadata before media download', () => {
		const validBundle = {
			mimetype: 'application/protobuf',
			fileSha256: new Uint8Array(32),
			mediaKey: new Uint8Array(32),
			fileEncSha256: new Uint8Array(32),
			messageHistoryMetadata: {
				historyReceivers: ['123@s.whatsapp.net'],
				oldestMessageTimestampInWindow: 1,
				messageCount: 1
			}
		}
		expect(isValidGroupHistoryBundle(validBundle)).toBe(true)
		expect(isValidGroupHistoryBundle({ ...validBundle, mediaKey: new Uint8Array(31) })).toBe(false)
		expect(isValidGroupHistoryBundle({ ...validBundle, messageHistoryMetadata: { historyReceivers: [] } })).toBe(false)
	})

	it('keeps only the most recent bundle keys and refreshes duplicates', () => {
		expect(addProcessedGroupHistoryBundle(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
		expect(addProcessedGroupHistoryBundle(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
	})

	it('only accepts bundles addressed to the current account', () => {
		expect(isGroupHistoryRecipient(['123:4@s.whatsapp.net'], ['123@s.whatsapp.net'])).toBe(true)
		expect(isGroupHistoryRecipient(['456@s.whatsapp.net'], ['123@s.whatsapp.net'])).toBe(false)
		expect(isGroupHistoryRecipient([], ['123@s.whatsapp.net'])).toBe(false)
	})

	it('rejects non-group and self-sent history bundles before download', async () => {
		const message = {
			key: { remoteJid: '123@s.whatsapp.net', fromMe: false },
			message: { messageHistoryBundle: {} }
		}
		expect(await downloadAndProcessGroupHistoryBundle(message, [], {})).toEqual({ messages: [], processed: false })
		expect(
			await downloadAndProcessGroupHistoryBundle({ ...message, key: { remoteJid: '123@g.us', fromMe: true } }, [], {})
		).toEqual({ messages: [], processed: false })
	})

	it('rejects group-history bundles older than the Web fallback window', () => {
		const now = 2_000_000_000
		expect(isGroupHistoryBundleWithinWindow(now - 14 * 24 * 60 * 60, now)).toBe(true)
		expect(isGroupHistoryBundleWithinWindow(now - (14 * 24 * 60 * 60 + 1), now)).toBe(false)
		expect(isGroupHistoryBundleWithinWindow(0, now)).toBe(false)
	})

	it('drops expired ephemeral messages but keeps messages saved for everyone', () => {
		const now = 2_000_000_000
		const expired = { messageTimestamp: now - 100, ephemeralDuration: 60 }
		expect(isGroupHistoryMessageWithinWindow(expired, now)).toBe(false)
		expect(
			isGroupHistoryMessageWithinWindow({ ...expired, keepInChat: { keepType: proto.KeepType.KEEP_FOR_ALL } }, now)
		).toBe(true)
		expect(isGroupHistoryMessageWithinWindow({ messageTimestamp: now - 90 * 24 * 60 * 60 }, now)).toBe(true)
		expect(isGroupHistoryMessageWithinWindow({ messageTimestamp: now - (90 * 24 * 60 * 60 + 1) }, now)).toBe(false)
	})

	it('matches the Web group-history content allowlist for ordinary content', () => {
		expect(isSupportedGroupHistoryMessage({ message: { conversation: 'hello' } })).toBe(true)
		expect(isSupportedGroupHistoryMessage({ message: { pollUpdateMessage: {} } })).toBe(true)
		expect(isSupportedGroupHistoryMessage({ message: { reactionMessage: {} } })).toBe(false)
		expect(isSupportedGroupHistoryMessage({ message: { listMessage: {} } })).toBe(false)
	})

	it('decodes WebMessageInfo entries from GroupHistory field 1', () => {
		const message = proto.WebMessageInfo.encode({
			key: { remoteJid: '123@g.us', id: 'history-message', fromMe: false },
			message: { conversation: 'history' }
		}).finish()
		const bundle = $protobuf.Writer.create().uint32(10).bytes(message).finish()

		expect(decodeGroupHistoryMessages(Buffer.from(bundle))).toMatchObject([
			{ key: { remoteJid: '123@g.us', id: 'history-message' }, message: { conversation: 'history' } }
		])
	})

	it('keeps only poll add-option messages from associated lists', () => {
		const message = proto.WebMessageInfo.encode({
			key: { remoteJid: '123@g.us', id: 'poll-option', fromMe: false },
			message: { pollUpdateMessage: { pollCreationMessageKey: { id: 'poll' } } }
		}).finish()
		const associated = (associationType: number) =>
			$protobuf.Writer.create().uint32(10).bytes(message).uint32(24).uint32(associationType).finish()
		const group = (associationType: number) =>
			$protobuf.Writer.create().uint32(18).bytes(associated(associationType)).finish()

		expect(
			decodeGroupHistoryMessages(Buffer.from(group(proto.MessageAssociation.AssociationType.MEDIA_POLL)))
		).toHaveLength(0)
		expect(
			decodeGroupHistoryMessages(Buffer.from(group(proto.MessageAssociation.AssociationType.POLL_ADD_OPTION)))
		).toHaveLength(1)
	})
})
