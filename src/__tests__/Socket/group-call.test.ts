import { binaryUnmarshalPackedNode, GroupSession } from '@skidy89/signal-protocol'
import { type BinaryNode } from '../../WABinary'
import { packGroupCallNode } from '../../Socket/features/call/calls'

const callId = 'group-call'
const creator = '100001:1@lid'
const self = '100002:1@lid'

const relay: BinaryNode = {
	tag: 'relay',
	attrs: { uuid: 'relay-uuid', participant_uuid: 'participant-uuid', warp_mi_tag_len: '8' },
	content: [
		{ tag: 'key', attrs: {}, content: Buffer.from('integrity-key') },
		{ tag: 'token', attrs: { id: '0' }, content: Buffer.from('relay-token') },
		{ tag: 'auth_token', attrs: { id: '0' }, content: Buffer.from('auth-token') },
		{
			tag: 'te2',
			attrs: { relay_id: '1', token_id: '0', auth_token_id: '0', relay_name: 'fixture' },
			content: Buffer.from([127, 0, 0, 1, 0x0d, 0x98])
		}
	]
}

const participants: BinaryNode[] = [
	{
		tag: 'user',
		attrs: { jid: '100001@lid', state: 'connected' },
		content: [{ tag: 'device', attrs: { jid: creator, pid: '1' } }]
	},
	{
		tag: 'user',
		attrs: { jid: '100002@lid', state: 'connected' },
		content: [{ tag: 'device', attrs: { jid: self, pid: '2' } }]
	}
]

const groupInfo = (transactionId?: string): BinaryNode => ({
	tag: 'group_info',
	attrs: {
		'call-id': callId,
		'call-creator': creator,
		media: 'audio',
		...(transactionId && { 'transaction-id': transactionId, 'connected-limit': '8' })
	},
	content: participants
})

describe('native group call media contract', () => {
	it('accepts an incoming invite snapshot before relay media is ready', () => {
		const session = new GroupSession(callId, creator, self)
		const invite: BinaryNode = {
			tag: 'offer',
			attrs: { 'call-id': callId, 'call-creator': creator, 'group-jid': 'group@g.us' },
			content: [groupInfo('7')]
		}
		expect(JSON.parse(session.applyInvite(packGroupCallNode(invite)))).toMatchObject({
			applied: 'applied',
			transactionId: 7,
			hasRelay: false
		})
	})

	it('applies ack and update snapshots, creates the relay engine, and installs an epoch', () => {
		const session = new GroupSession(callId, creator, self)
		const ack: BinaryNode = { tag: 'ack', attrs: {}, content: [groupInfo(), relay] }
		const packedAck = packGroupCallNode(ack)
		expect(binaryUnmarshalPackedNode(packedAck)).toContain('ack')
		const initial = JSON.parse(session.applyAck(packedAck))
		expect(initial).toMatchObject({ applied: 'applied', hasRelay: true, transactionId: 0 })

		const engine = session.createEngine(false, true, false)
		const update: BinaryNode = {
			tag: 'group_update',
			attrs: { 'call-id': callId, 'call-creator': creator },
			content: [groupInfo('7'), relay]
		}
		expect(JSON.parse(session.applyUpdate(packGroupCallNode(update)))).toMatchObject({
			applied: 'applied',
			hasRelay: true,
			transactionId: 7
		})
		expect(session.pushToEngine(engine, 0)).toBeTruthy()
		expect(engine.applyGroupEpoch(7, Buffer.alloc(32, 0x42))).toEqual(expect.any(String))
	})
})
