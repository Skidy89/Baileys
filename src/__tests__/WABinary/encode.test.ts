import { describe, expect, it } from '@jest/globals'
import type { BinaryNode } from '../../WABinary'
import { encodeBinaryNode } from '../../WABinary/encode'
import { decodeBinaryNode } from '../../WABinary/decode'

describe('encodeBinaryNode', () => {
	it('preserves the encoded format for tokenized nodes and nested content', () => {
		const node = {
			tag: 'iq',
			attrs: { id: 'ABCD1234', type: 'get', xmlns: 'w:profile:picture', to: '123456789@s.whatsapp.net' },
			content: [{ tag: 'picture', attrs: { type: 'image' } }]
		}

		expect(encodeBinaryNode(node)).toEqual(
			Buffer.from('00f80a1908fb04abcd12340429164211faff85123456789f03f801f803210443', 'hex')
		)
	})

	it('preserves packed text, device JIDs, and binary payload bytes', () => {
		const textNode = {
			tag: 'message',
			attrs: { id: '3EB0A0', to: '123:4@s.whatsapp.net', type: 'text' },
			content: [{ tag: 'body', attrs: {}, content: 'hello 123456789' }]
		}
		const mediaNode = { tag: 'media', attrs: { id: '01' }, content: Buffer.from([0, 1, 2, 253, 254, 255]) }

		expect(encodeBinaryNode(textNode)).toEqual(
			Buffer.from('00f8081308fb033eb0a011f70004ff82123f0438f801f802ed75fc0f68656c6c6f20313233343536373839', 'hex')
		)
		expect(encodeBinaryNode(mediaNode)).toEqual(Buffer.from('00f8043708c7fc06000102fdfeff', 'hex'))
	})

	it('packs uppercase hex but leaves lowercase hex as UTF-8', async () => {
		const uppercase = { tag: 'message', attrs: { id: 'ABCDEF' } }
		const lowercase = { tag: 'message', attrs: { id: 'abcdef' } }
		const upperEncoded = encodeBinaryNode(uppercase)
		const lowerEncoded = encodeBinaryNode(lowercase)

		expect(upperEncoded.length).toBeLessThan(lowerEncoded.length)
		expect((await decodeBinaryNode(lowerEncoded)).attrs).toEqual(lowercase.attrs)
	})

	it('preserves odd-length nibble packing', async () => {
		const node = { tag: 'message', attrs: { id: '12-345.' } }
		const decoded = await decodeBinaryNode(encodeBinaryNode(node))

		expect(decoded.attrs).toEqual(node.attrs)
	})

	it('encodes raw UTF-8 strings without changing their content', async () => {
		const node = {
			tag: 'custom-node',
			attrs: { 'custom-attribute': 'acción-🌍'.repeat(4) },
			content: [{ tag: 'custom-child', attrs: {}, content: 'mensaje-你好'.repeat(4) }]
		}

		const decoded = await decodeBinaryNode(encodeBinaryNode(node))
		expect(decoded.attrs).toEqual(node.attrs)
		expect((decoded.content as BinaryNode[])[0]?.content).toEqual(Buffer.from('mensaje-你好'.repeat(4)))
	})

	it('continues appending to a caller supplied number buffer', () => {
		const node = { tag: 'media', attrs: { id: '01' }, content: Buffer.from([0, 1, 2, 253, 254, 255]) }
		const buffer = [0]

		const encoded = encodeBinaryNode(node, undefined, buffer)

		expect(encoded).toEqual(Buffer.from('00f8043708c7fc06000102fdfeff', 'hex'))
		expect(Buffer.from(buffer)).toEqual(encoded)
	})

	it('encodes and decodes large binary content through the growing buffer', async () => {
		const payload = Buffer.alloc(1024 * 1024, 0x5a)
		const encoded = encodeBinaryNode({ tag: 'media', attrs: { id: 'large' }, content: payload })
		const decoded = await decodeBinaryNode(encoded)

		expect(decoded.content).toEqual(payload)
	})

	it('decodes a wide node list', async () => {
		const children = Array.from({ length: 1000 }, (_, index) => ({
			tag: 'item',
			attrs: { id: String(index) },
			content: Buffer.from([index & 0xff])
		}))
		const decoded = await decodeBinaryNode(encodeBinaryNode({ tag: 'list', attrs: {}, content: children }))

		expect(decoded.content).toHaveLength(children.length)
		expect(decoded.content?.[999]).toEqual(children[999])
	})

	it('rejects invalid uncompressed frames asynchronously', async () => {
		await expect(decodeBinaryNode(Buffer.alloc(0))).rejects.toThrow()
	})
})
