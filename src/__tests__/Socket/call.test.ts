import {
	buildAccept,
	buildOffer,
	buildPreaccept,
	buildTerminate,
	buildVideoState,
	mediaConfigFromRelay,
	newCallId
} from '../../Socket/features/call/calls'
import { callAck, parseCall, rejectCallNode, terminateCallNode } from '../../Socket/features/call/call-events'
import { splitAnnexB } from '../../Socket/features/call/media-file'
import type { BinaryNode } from '../../WABinary'

describe('call signaling nodes', () => {
	it('builds audio and video offers with recipient keys', () => {
		const offer = buildOffer({
			callId: 'call',
			to: 'peer',
			creator: 'self',
			id: 'id',
			video: true,
			keys: [
				{ jid: 'device-1', type: 'msg', ciphertext: Buffer.from([1]) },
				{ jid: 'device-2', type: 'pkmsg', ciphertext: Buffer.from([2]) }
			]
		})
		const action = (offer.content as BinaryNode[])[0]!
		const children = action.content as BinaryNode[]
		expect(children.map(child => child.tag)).toEqual(['audio', 'video', 'net', 'capability', 'destination', 'encopt'])
		expect(children[4]!.content).toEqual([
			{
				tag: 'to',
				attrs: { jid: 'device-1' },
				content: [{ tag: 'enc', attrs: { v: '2', type: 'msg', count: '0' }, content: Buffer.from([1]) }]
			},
			{
				tag: 'to',
				attrs: { jid: 'device-2' },
				content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg', count: '0' }, content: Buffer.from([2]) }]
			}
		])
	})

	it('builds call state nodes and unique call ids', () => {
		expect(buildPreaccept('c', 'p', 's', 'i', false).content).toMatchObject([{ tag: 'preaccept' }])
		expect(
			((buildAccept('c', 'p', 's', 'i', true).content as BinaryNode[])[0]!.content as BinaryNode[]).map(
				child => child.tag
			)
		).toContain('video')
		expect(buildTerminate('c', 'p', 's', 'i').content).toMatchObject([{ tag: 'terminate' }])
		expect(buildVideoState('c', 'p', 's', 'i', 1).content).toMatchObject([
			{ tag: 'video', attrs: expect.objectContaining({ state: '1' }) }
		])
		expect(newCallId()).toMatch(/^00[0-9a-f]{30}$/)
		expect(newCallId()).not.toBe(newCallId())
	})

	it('parses events, ignores incomplete nodes, and acknowledges actions', () => {
		const node: BinaryNode = {
			tag: 'call',
			attrs: { id: 'ack-id', from: 'peer', t: '10', offline: '1' },
			content: [
				{
					tag: 'offer',
					attrs: { 'call-id': 'call', 'call-creator': 'self', 'group-jid': 'group', lightweight: '1' },
					content: [{ tag: 'video', attrs: {} }]
				}
			]
		}
		expect(parseCall(node)).toMatchObject({
			id: 'call',
			from: 'peer',
			creator: 'self',
			chatId: 'group',
			groupJid: 'group',
			isVideo: true,
			lightweight: true,
			status: 'offer',
			offline: true,
			date: new Date(10_000)
		})
		expect(parseCall({ ...node, content: [{ tag: 'offer', attrs: {} }] })).toBeUndefined()
		expect(callAck(node)).toEqual({ tag: 'ack', attrs: { id: 'ack-id', to: 'peer', class: 'call', type: 'offer' } })
		expect(rejectCallNode('c', 'p', 's', 'i').content).toMatchObject([{ tag: 'reject', attrs: { count: '0' } }])
		expect(terminateCallNode('c', 'p', 's', 'i').content).toMatchObject([{ tag: 'terminate' }])
	})
})

describe('call relay and video media helpers', () => {
	const relay: BinaryNode = {
		tag: 'relay',
		attrs: { warp_mi_tag_len: '8' },
		content: [
			{ tag: 'key', attrs: {}, content: Buffer.from([9]) },
			{ tag: 'te', attrs: { token_id: '1', auth_token_id: '0' }, content: Buffer.from([127, 0, 0, 1, 0x13, 0x88]) },
			{ tag: 'token', attrs: { id: '0' }, content: Buffer.from([3]) },
			{ tag: 'token', attrs: { id: '1' }, content: Buffer.from([4]) },
			{ tag: 'auth_token', attrs: { id: '0' }, content: Buffer.from([5]) }
		]
	}

	it('selects the endpoint tokens and rejects incomplete relay data', () => {
		expect(mediaConfigFromRelay(relay, 'call', 'incoming', 'self', 'peer', new Uint8Array(32), true)).toMatchObject({
			relayIp: '127.0.0.1',
			relayPort: 5000,
			relayToken: Buffer.from([4]),
			authToken: Buffer.from([5]),
			warpMiTagLen: 8,
			direction: 'incoming',
			enableVideo: true
		})
		expect(() =>
			mediaConfigFromRelay(
				{ tag: 'relay', attrs: {}, content: [] },
				'call',
				'incoming',
				'self',
				'peer',
				new Uint8Array(32),
				false
			)
		).toThrow('call relay has no usable key or endpoint')
	})

	it('splits Annex-B access units and rejects streams without delimiters', () => {
		const data = Buffer.from([0, 0, 0, 1, 9, 1, 2, 0, 0, 1, 9, 3])
		expect(splitAnnexB(data)).toEqual([data.subarray(0, 7), data.subarray(7)])
		expect(() => splitAnnexB(Buffer.from([1, 2, 3]))).toThrow('no access-unit delimiters')
	})
})
