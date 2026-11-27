import {
	buildAccept,
	buildGroupOffer,
	acknowledgeOffer,
	type CallState,
	buildOffer,
	buildPreaccept,
	buildTerminate,
	buildVideoState,
	getCallOfferEnc,
	isCallActive,
	mediaConfigFromRelay,
	groupRelayEndpointFromNode,
	buildGroupEncRekey,
	newCallId
} from '../../Socket/features/call/calls'
import {
	callAckOrReceipt,
	callReceipt,
	parseCall,
	rejectCallNode,
	terminateCallNode
} from '../../Socket/features/call/call-events'
import { splitAnnexB } from '../../Socket/features/call/media-file'
import type { BinaryNode } from '../../WABinary'

describe('call signaling nodes', () => {
	it('treats a call removed or ended during async signaling as inactive', () => {
		const call: CallState = {
			callId: 'c',
			peer: 'p',
			creator: 's',
			direction: 'outgoing',
			video: false,
			devices: [],
			status: 'server_ack',
			startedAt: 0
		}
		const calls = new Map([[call.callId, call]])
		expect(isCallActive(calls, call)).toBe(true)
		call.status = 'ended'
		calls.delete(call.callId)
		expect(isCallActive(calls, call)).toBe(false)
	})

	it('keeps offer acknowledgement separate from remote ringing', () => {
		const call: CallState = {
			callId: 'c',
			peer: 'p',
			creator: 's',
			direction: 'outgoing',
			video: false,
			devices: [],
			status: 'offer_sent',
			startedAt: 0
		}
		const ack = { tag: 'ack', attrs: { class: 'call', id: 'i' } }
		expect(() => acknowledgeOffer(call, { ...ack, attrs: { ...ack.attrs, error: '403' } }, 'i')).toThrow('403')
		expect(call.status).toBe('offer_sent')
		acknowledgeOffer(call, ack, 'i')
		expect(call.status).toBe('server_ack')
		call.status = 'ringing'
		acknowledgeOffer(call, ack, 'i')
		expect(call.status).toBe('ringing')
		expect(
			parseCall({ tag: 'call', attrs: { from: 'peer' }, content: [{ tag: 'heartbeat', attrs: { 'call-id': 'c' } }] })
		).toBeUndefined()
	})

	it('addresses a group-bound offer to the call with a device roster', () => {
		const node = buildGroupOffer(
			'c',
			'i',
			'1:2@lid',
			'g@g.us',
			new Map([
				['1@lid', ['1:2@lid']],
				['2@lid', ['2@lid']]
			]),
			false
		)
		expect(node.attrs.to).toBe('c@call')
		const action = (node.content as BinaryNode[])[0]!
		expect(action.attrs['group-jid']).toBe('g@g.us')
		const children = action.content as BinaryNode[]
		expect(children.map(c => c.tag)).toEqual(['audio', 'net', 'group_info'])
		expect(children[2]?.content).toMatchObject([
			{ attrs: { jid: '1@lid' }, content: [{ attrs: { jid: '1:2@lid' } }] },
			{ attrs: { jid: '2@lid' }, content: [{ attrs: { jid: '2@lid' } }] }
		])
	})

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
		for (const tag of ['accept', 'reject']) {
			expect(
				callAckOrReceipt({ ...node, content: [{ tag, attrs: { 'call-id': 'call', 'call-creator': 'self' } }] })
			).toEqual({
				tag: 'receipt',
				attrs: { id: 'ack-id', to: 'peer' },
				content: [{ tag, attrs: { 'call-id': 'call', 'call-creator': 'self' } }]
			})
		}
		expect(
			callAckOrReceipt({
				...node,
				content: [{ tag: 'enc_rekey', attrs: { 'call-id': 'call', 'call-creator': 'self' } }]
			})
		).toBeUndefined()
		expect(
			callAckOrReceipt({ ...node, content: [{ tag: 'offer', attrs: { 'call-id': 'call', 'call-creator': 'self' } }] })
		).toBeUndefined()
		expect(callReceipt(node)).toEqual({
			tag: 'receipt',
			attrs: { id: 'ack-id', to: 'peer' },
			content: [{ tag: 'offer', attrs: { 'call-id': 'call', 'call-creator': 'self' } }]
		})
		expect(callAckOrReceipt({ ...node, content: [{ tag: 'terminate', attrs: { 'call-id': 'call' } }] })).toMatchObject({
			tag: 'ack',
			attrs: { class: 'call', type: 'terminate' }
		})
		expect(rejectCallNode('c', 'p', 's', 'i').content).toMatchObject([{ tag: 'reject', attrs: { count: '0' } }])
		expect(terminateCallNode('c', 'p', 's', 'i').content).toMatchObject([{ tag: 'terminate' }])
	})

	it('selects the encrypted offer key addressed to this device', () => {
		const direct = { tag: 'enc', attrs: { type: 'pkmsg' }, content: Buffer.from([1]) }
		const forSelf = { tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from([2]) }
		const forOther = { tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from([3]) }
		const action: BinaryNode = {
			tag: 'offer',
			attrs: {},
			content: [
				{
					tag: 'destination',
					attrs: {},
					content: [
						{ tag: 'to', attrs: { jid: 'other' }, content: [forOther] },
						{ tag: 'to', attrs: { jid: 'self-lid' }, content: [forSelf] }
					]
				}
			]
		}
		expect(getCallOfferEnc(action, ['self-pn', 'self-lid'])).toEqual(forSelf)
		expect(getCallOfferEnc({ ...action, content: [direct] }, ['self-lid'])).toEqual(direct)
		expect(getCallOfferEnc(action, ['unknown'])).toBeUndefined()
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

	it('prefers the web relay port with a usable token over the first address', () => {
		const extra = (port: number, token: string) => ({
			tag: 'te2',
			attrs: { token_id: token },
			content: Buffer.from([1, 2, 3, 4, port >> 8, port & 255])
		})
		const content = [extra(3478, '0'), extra(3480, '9'), extra(3480, '1'), ...(relay.content as BinaryNode[])]
		expect(
			mediaConfigFromRelay({ ...relay, content }, 'call', 'outgoing', 'self', 'peer', Buffer.alloc(32), false)
		).toMatchObject({ relayPort: 3480, relayToken: Buffer.from([4]) })
	})

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

	it('keeps authenticated IPv6 relay candidates usable', () => {
		const ipv6 = Buffer.alloc(18)
		ipv6.writeUInt16BE(0x2001, 0)
		ipv6.writeUInt16BE(0xdb8, 2)
		ipv6.writeUInt16BE(3480, 16)
		const config = mediaConfigFromRelay(
			{
				tag: 'relay',
				attrs: {},
				content: [
					{ tag: 'key', attrs: {}, content: Buffer.from([9]) },
					{ tag: 'te2', attrs: { token_id: '0' }, content: ipv6 },
					{ tag: 'token', attrs: { id: '0' }, content: Buffer.from([3]) }
				]
			},
			'call',
			'outgoing',
			'self',
			'peer',
			Buffer.alloc(32),
			false
		)
		expect(config).toMatchObject({ relayIp: '2001:db8:0:0:0:0:0:0', relayPort: 3480 })
	})

	it('selects the native group media relay endpoint and its indexed token', () => {
		const endpoint = (port: number, token: string, isFna = false) => ({
			tag: 'te2',
			attrs: { relay_id: '1', token_id: token, auth_token_id: '0', relay_name: 'relay', ...(isFna && { is_fna: '1' }) },
			content: Buffer.from([203, 0, 113, 1, port >> 8, port & 255])
		})
		const relay: BinaryNode = {
			tag: 'relay',
			attrs: {},
			content: [
				endpoint(3478, '0'),
				endpoint(3480, '2'),
				endpoint(3480, '1', true),
				{ tag: 'token', attrs: { id: '0' }, content: Buffer.from([1]) },
				{ tag: 'token', attrs: { id: '1' }, content: Buffer.from([2]) },
				{ tag: 'token', attrs: { id: '2' }, content: Buffer.from([3]) }
			]
		}
		expect(groupRelayEndpointFromNode(relay)).toEqual({ relayIp: '203.0.113.1', relayPort: 3480 })
		expect(() => groupRelayEndpointFromNode({ tag: 'relay', attrs: {}, content: [endpoint(3478, '9')] })).toThrow(
			'group relay has no usable media endpoint'
		)
	})

	it('builds an encrypted group epoch stanza for one target device', () => {
		expect(
			buildGroupEncRekey({
				callId: 'call',
				creator: '1:2@lid',
				to: '3:4@lid',
				id: 'msg-id',
				transactionId: 7,
				encrypted: { type: 'msg', ciphertext: Buffer.from([1, 2]) }
			})
		).toEqual({
			tag: 'call',
			attrs: { to: '3:4@lid', id: 'msg-id' },
			content: [
				{
					tag: 'enc_rekey',
					attrs: { 'call-id': 'call', 'call-creator': '1:2@lid', 'transaction-id': '7' },
					content: [
						{ tag: 'encopt', attrs: { keygen: '2' } },
						{ tag: 'enc', attrs: { v: '2', type: 'msg', count: '0' }, content: Buffer.from([1, 2]) }
					]
				}
			]
		})
	})

	it('splits Annex-B access units and rejects streams without delimiters', () => {
		const data = Buffer.from([0, 0, 0, 1, 9, 1, 2, 0, 0, 1, 9, 3])
		expect(splitAnnexB(data)).toEqual([data.subarray(0, 7), data.subarray(7)])
		expect(() => splitAnnexB(Buffer.from([1, 2, 3]))).toThrow('no access-unit delimiters')
	})
})
