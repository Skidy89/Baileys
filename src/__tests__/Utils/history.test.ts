import { describe, expect, it, jest } from '@jest/globals'
import { readFile, unlink } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { proto } from '../../../WAProto/index.js'
import { encryptedStream } from '../../Utils/messages/media/upload'
import { downloadHistory, processHistoryMessage } from '../../Utils/history'

describe('processHistoryMessage', () => {
	it('extracts missing LID-to-PN mappings during the message pass', () => {
		const history = proto.HistorySync.fromObject({
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			conversations: [
				{
					id: '123@lid',
					messages: [
						{
							message: {
								key: { id: 'incoming', remoteJid: '123@lid', fromMe: false },
								messageTimestamp: 1
							}
						},
						{
							message: {
								key: { id: 'outgoing', remoteJid: '123@lid', fromMe: true },
								messageTimestamp: 2,
								userReceipt: [{ userJid: '123456789@s.whatsapp.net' }]
							}
						}
					]
				}
			]
		})

		const result = processHistoryMessage(history)

		expect(result.lidPnMappings).toEqual([{ lid: '123@lid', pn: '123456789@s.whatsapp.net' }])
		expect(result.messages).toHaveLength(2)
		expect(result.chats[0]?.messages).toHaveLength(1)
	})
})

describe('downloadHistory', () => {
	it('inflates and decodes streamed history media', async () => {
		const history = proto.HistorySync.fromObject({ syncType: proto.HistorySync.HistorySyncType.RECENT })
		const compressed = deflateSync(proto.HistorySync.encode(history).finish())
		const encrypted = await encryptedStream(compressed, 'md-msg-hist')
		const fetchSpy = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(await readFile(encrypted.encFilePath)))

		try {
			const result = await downloadHistory(
				proto.Message.HistorySyncNotification.fromObject({
					mediaKey: encrypted.mediaKey,
					directPath: '/media'
				}),
				{}
			)

			expect(result.syncType).toBe(proto.HistorySync.HistorySyncType.RECENT)
		} finally {
			fetchSpy.mockRestore()
			await unlink(encrypted.encFilePath)
		}
	})
})
