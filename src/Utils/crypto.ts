import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto'
import HKDF from 'futoin-hkdf'
import { curve } from '@skidy89/signal-protocol'
import type { KeyPair } from '../Types'
import { KEY_BUNDLE_TYPE } from '../Defaults'

export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) =>
	pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const { pubKey, privKey } = curve.generateKeyPair()
		if (pubKey.length !== 33) {
			throw new Error(`Invalid pubKey length: ${pubKey.length}`)
		}
		return {
			private: privKey,
			public: pubKey.subarray(1)
		}
	},
	generateKeyPairs: (count: number): KeyPair[] => {
		const keyPairs = curve.generateKeyPairs(count)
		return keyPairs.map(({ pubKey, privKey }) => {
			if (pubKey.length !== 33) {
				throw new Error(`Invalid pubKey length: ${pubKey.length}`)
			}
			return {
				private: privKey,
				public: pubKey.subarray(1)
			}
		})
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		const shared = curve.calculateAgreement(publicKey as Buffer, privateKey as Buffer)
		return shared
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => curve.calculateSignature(privateKey as Buffer, buf as Buffer),
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		return curve.verifySignature(pubKey as Buffer, message as Buffer, signature as Buffer)
	}
}

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	const keyPair = Curve.generateKeyPair()
	const signature = Curve.sign(identityKeyPair.private, generateSignalPubKey(keyPair.public))
	return { keyPair, signature, keyId }
}

const GCM_TAG_LENGTH = 128 >> 3

/**
 * encrypt AES 256 GCM;
 * where the tag tag is suffixed to the ciphertext
 * */
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(additionalData)
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/**
 * decrypt AES 256 GCM;
 * where the auth tag is suffixed to the ciphertext
 * */
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	// decrypt additional adata
	const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH)
	const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH)
	// set additional data
	decipher.setAAD(additionalData)
	decipher.setAuthTag(tag)

	return Buffer.concat([decipher.update(enc), decipher.final()])
}

export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	const cipher = createCipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	const decipher = createDecipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** decrypt AES 256 CBC; where the IV is prefixed to the buffer */
export function aesDecrypt(buffer: Buffer | Uint8Array, key: Buffer | Uint8Array) {
	return aesDecryptWithIV(buffer.subarray(16, buffer.length), key, buffer.subarray(0, 16))
}

/** decrypt AES 256 CBC */
export function aesDecryptWithIV(buffer: Buffer | Uint8Array, key: Buffer | Uint8Array, IV: Buffer | Uint8Array) {
	const aes = createDecipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()])
}

// encrypt AES 256 CBC; where a random IV is prefixed to the buffer
export function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer | Uint8Array) {
	const IV = randomBytes(16)
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([IV, aes.update(buffer), aes.final()]) // prefix IV to the buffer
}

// encrypt AES 256 CBC with a given IV
export function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()]) // prefix IV to the buffer
}

// sign HMAC using SHA 256
export function hmacSign(
	buffer: Buffer | Uint8Array,
	key: Buffer | Uint8Array,
	variant: 'sha256' | 'sha512' = 'sha256'
) {
	return createHmac(variant, key).update(buffer).digest()
}

export function sha256(buffer: Buffer) {
	return createHash('sha256').update(buffer).digest()
}

export function md5(buffer: Buffer) {
	return createHash('md5').update(buffer).digest()
}

// HKDF key expansion
export function hkdf(buffer: Uint8Array | Buffer, expandedLength: number, info: { salt?: Buffer; info?: string }) {
	return HKDF(!Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer, expandedLength, info)
}

export function derivePairingCodeKey(pairingCode: string, salt: Buffer) {
	return pbkdf2Sync(pairingCode, salt, 2 << 16, 32, 'sha256')
}
