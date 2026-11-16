import { describe, expect, it, jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationState } from '../../Types'
import type { SignalRepository } from '../../Types/Signal'
import { makeKeyedMutex } from '../../Utils/make-mutex'
import { unpadRandomMax16 } from '../../Utils/generics'
import { makeParticipantNodeCreator } from '../../Socket/messages/participant-nodes'

describe('participant node creation', () => {
	it('serializes each shared message once while keeping per-recipient padding', async () => {
		const message = { conversation: 'hello recipients' }
		const expected = proto.Message.encode(message).finish()
		const encode = jest.spyOn(proto.Message, 'encode')
		const encrypted: Array<{ jid: string; data: Uint8Array }> = []
		const signalRepository = {
			encryptMessage: async ({ jid, data }: { jid: string; data: Uint8Array }) => {
				encrypted.push({ jid, data })
				return { type: 'msg' as const, ciphertext: data }
			}
		} as unknown as SignalRepository
		const createParticipantNodes = makeParticipantNodeCreator({
			patchMessageBeforeSending: async msg => msg,
			authState: { creds: { me: { id: '999@s.whatsapp.net' } } } as AuthenticationState,
			signalRepository,
			encryptionMutex: makeKeyedMutex()
		})

		try {
			const { nodes } = await createParticipantNodes(
				['123:1@s.whatsapp.net', '123:2@s.whatsapp.net', '123:3@s.whatsapp.net'],
				message
			)

			expect(nodes).toHaveLength(3)
			expect(encode).toHaveBeenCalledTimes(1)
			expect(encrypted.map(({ data }) => Buffer.from(unpadRandomMax16(data)))).toEqual([expected, expected, expected])
		} finally {
			encode.mockRestore()
		}
	})

	it('keeps cached encodings separate for DSM and regular device messages', async () => {
		const message = { conversation: 'regular message' }
		const dsmMessage = { conversation: 'device sync message' }
		const expected = new Map([
			['regular', proto.Message.encode(message).finish()],
			['dsm', proto.Message.encode(dsmMessage).finish()]
		])
		const encode = jest.spyOn(proto.Message, 'encode')
		const encrypted = new Map<string, Uint8Array>()
		const signalRepository = {
			encryptMessage: async ({ jid, data }: { jid: string; data: Uint8Array }) => {
				encrypted.set(jid, data)
				return { type: 'msg' as const, ciphertext: data }
			}
		} as unknown as SignalRepository
		const createParticipantNodes = makeParticipantNodeCreator({
			patchMessageBeforeSending: async msg => msg,
			authState: { creds: { me: { id: '123:0@s.whatsapp.net' } } } as AuthenticationState,
			signalRepository,
			encryptionMutex: makeKeyedMutex()
		})

		try {
			await createParticipantNodes(
				['123:1@s.whatsapp.net', '123:0@s.whatsapp.net', '456:1@s.whatsapp.net'],
				message,
				undefined,
				dsmMessage
			)

			expect(encode).toHaveBeenCalledTimes(2)
			expect(Buffer.from(unpadRandomMax16(encrypted.get('123:1@s.whatsapp.net')!))).toEqual(expected.get('dsm'))
			expect(Buffer.from(unpadRandomMax16(encrypted.get('123:0@s.whatsapp.net')!))).toEqual(expected.get('regular'))
			expect(Buffer.from(unpadRandomMax16(encrypted.get('456:1@s.whatsapp.net')!))).toEqual(expected.get('regular'))
		} finally {
			encode.mockRestore()
		}
	})
})
