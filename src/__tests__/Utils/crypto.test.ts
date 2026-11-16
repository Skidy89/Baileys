import { describe, expect, it } from '@jest/globals'
import { aesDecryptCTR, aesEncryptCTR, aesDecryptGCM, aesEncryptGCM, hkdf } from '../../Utils/crypto'

describe('AES-CTR decryption', () => {
	it('decrypts a non-zero-offset Uint8Array view', () => {
		const key = Buffer.alloc(32, 3)
		const iv = Buffer.alloc(16, 4)
		const plaintext = Buffer.from('message body')
		const ciphertext = aesEncryptCTR(plaintext, key, iv)
		const padded = Buffer.concat([Buffer.from([0]), ciphertext, Buffer.from([0])])
		const view = new Uint8Array(padded.buffer, padded.byteOffset + 1, ciphertext.length)

		expect(aesDecryptCTR(view, key, iv)).toEqual(plaintext)
	})
})

describe('AES-GCM decryption', () => {
	it('decrypts a Uint8Array view with a non-zero byte offset', () => {
		const key = Buffer.alloc(32, 1)
		const iv = Buffer.alloc(12, 2)
		const aad = Buffer.from('header')
		const plaintext = Buffer.from('message body')
		const ciphertext = aesEncryptGCM(plaintext, key, iv, aad)
		const padded = Buffer.concat([Buffer.from([0]), ciphertext, Buffer.from([0])])
		const view = new Uint8Array(padded.buffer, padded.byteOffset + 1, ciphertext.length)

		expect(aesDecryptGCM(view, key, iv, aad)).toEqual(plaintext)
	})

	it('rejects a ciphertext with a modified authentication tag', () => {
		const key = Buffer.alloc(32, 1)
		const iv = Buffer.alloc(12, 2)
		const ciphertext = aesEncryptGCM(Buffer.from('message body'), key, iv, Buffer.alloc(0))
		ciphertext[ciphertext.length - 1] ^= 1

		expect(() => aesDecryptGCM(ciphertext, key, iv, Buffer.alloc(0))).toThrow()
	})
})

describe('hkdf', () => {
	it('derives the existing SHA-256 output with salt and info', () => {
		expect(hkdf(Buffer.from('ikm'), 42, { salt: Buffer.from('salt'), info: 'info' }).toString('hex')).toBe(
			'fe8f9615d2374c0d17f77d1aeaf408c2e75fe0466073d0def23c733e2f862dfd6814c9254418fa112fe8'
		)
	})

	it('supports omitted salt and info', () => {
		expect(hkdf(Buffer.from('ikm'), 42, {}).toString('hex')).toBe(
			'd58e7c1c4394984eb3ca168ff7b709d44f8db0e9f6f00a0ac1c01a2e4d0ad350c758da95053f1ac71c19'
		)
	})
})
