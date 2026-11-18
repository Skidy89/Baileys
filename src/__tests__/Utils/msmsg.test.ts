import { createCipheriv, hkdfSync } from 'node:crypto'
import { describe, expect, it } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { decryptMsmsg, MessageSecrets } from '../../Utils/msmsg'

const hkdf = (ikm: Uint8Array, info: Uint8Array) => Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32))

const encrypt = (secret: Buffer, ctx: { botJid: string; target: string; id: string }, plaintext: Buffer) => {
	const k1 = hkdf(secret, Buffer.from('Bot Message'))
	const key = hkdf(k1, Buffer.from(ctx.id + ctx.target + ctx.botJid))
	const iv = Buffer.alloc(12, 7)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(Buffer.concat([Buffer.from(ctx.id), Buffer.from([0]), Buffer.from(ctx.botJid)]))
	return { iv, payload: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]) }
}

describe('msmsg decryption', () => {
	it('decrypts the payload using the target message secret and bound context', () => {
		const secret = Buffer.alloc(32, 3)
		const context = { botJid: 'meta@bot', target: '123@lid', id: 'target-message' }
		const plaintext = Buffer.from('decoded bot response')
		const encrypted = encrypt(secret, context, plaintext)
		const wrapped = proto.MessageSecretMessage.decode(
			proto.MessageSecretMessage.encode({ encIv: encrypted.iv, encPayload: encrypted.payload }).finish()
		)

		expect(
			decryptMsmsg(
				secret,
				{
					botJid: context.botJid,
					meId: '123@s.whatsapp.net',
					meLid: context.target,
					metaTargetId: context.id
				},
				wrapped.encIv!,
				wrapped.encPayload!
			)
		).toEqual(plaintext)
	})

	it('rejects malformed IVs and authenticated payloads', () => {
		const secret = Buffer.alloc(32, 3)
		const context = { botJid: 'meta@bot', target: '123@lid', id: 'target-message' }
		const encrypted = encrypt(secret, context, Buffer.from('response'))
		const payload = Buffer.from(encrypted.payload)
		payload[payload.length - 1] ^= 1

		expect(() =>
			decryptMsmsg(
				secret,
				{
					botJid: context.botJid,
					meId: '123@s.whatsapp.net',
					meLid: context.target,
					metaTargetId: context.id
				},
				Buffer.alloc(16),
				payload
			)
		).toThrow('invalid IV length')
		expect(() =>
			decryptMsmsg(
				secret,
				{
					botJid: context.botJid,
					meId: '123@s.whatsapp.net',
					meLid: context.target,
					metaTargetId: context.id
				},
				encrypted.iv,
				payload
			)
		).toThrow('all key derivation candidates exhausted')
	})
})

describe('MessageSecrets', () => {
	it('keeps the first secret for an id and tries named ids before recent chat secrets', () => {
		const secrets = new MessageSecrets()
		const first = Buffer.alloc(32, 1)
		const second = Buffer.alloc(32, 2)
		secrets.set('target', first, 'chat', 'author')
		secrets.set('target', second, 'chat', 'attacker')
		secrets.set('recent', second, 'chat', 'author')

		expect(secrets.byId('target')).toEqual(first)
		expect(secrets.originOf('target')).toEqual({ author: 'author', chat: 'chat' })
		expect(secrets.candidates(['target'], 'chat')).toEqual([first, second])
	})
})
