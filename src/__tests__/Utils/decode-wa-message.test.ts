import { describe, expect, it } from '@jest/globals'
import { decodeMessageNode, decryptMessageNode } from '../../Utils/decode-wa-message'
import type { BinaryNode } from '../../WABinary'

const decode = (attrs: BinaryNode['attrs'], meId = '111@s.whatsapp.net', meLid = '222@lid') =>
	decodeMessageNode({ tag: 'message', attrs, content: [] }, meId, meLid).fullMessage

describe('decodeMessageNode', () => {
	it('recognizes own outgoing messages without repeatedly decoding the sender JID', () => {
		const message = decode({
			id: 'outgoing',
			from: '111:4@s.whatsapp.net',
			recipient: '333@s.whatsapp.net',
			t: '1700000000'
		})

		expect(message.key).toMatchObject({ fromMe: true, remoteJid: '333@s.whatsapp.net' })
	})

	it('learns a recipient PN/LID pair and its latest LID from self messages', () => {
		const { lidPnMappings } = decodeMessageNode(
			{
				tag: 'message',
				attrs: {
					id: 'outgoing',
					from: '111@s.whatsapp.net',
					recipient: '333@s.whatsapp.net',
					peer_recipient_lid: '444@lid',
					recipient_latest_lid: '555@lid',
					t: '1700000000'
				},
				content: []
			},
			'111@s.whatsapp.net',
			'222@lid'
		)

		expect(lidPnMappings).toEqual([
			{ lid: '444@lid', pn: '333@s.whatsapp.net' },
			{ lid: '555@lid', pn: '333@s.whatsapp.net' }
		])
	})

	it('learns a recipient LID when a self message is addressed to a LID', () => {
		const { lidPnMappings } = decodeMessageNode(
			{
				tag: 'message',
				attrs: {
					id: 'outgoing-lid',
					from: '111@s.whatsapp.net',
					recipient: '444@lid',
					peer_recipient_pn: '333@s.whatsapp.net',
					recipient_latest_lid: '555@lid',
					t: '1700000000'
				},
				content: []
			},
			'111@s.whatsapp.net',
			'222@lid'
		)

		expect(lidPnMappings).toEqual([
			{ lid: '444@lid', pn: '333@s.whatsapp.net' },
			{ lid: '555@lid', pn: '333@s.whatsapp.net' }
		])
	})

	it('does not apply recipient-latest-LID mappings to incoming messages', () => {
		const { lidPnMappings } = decodeMessageNode(
			{
				tag: 'message',
				attrs: {
					id: 'incoming',
					from: '333@s.whatsapp.net',
					peer_recipient_lid: '444@lid',
					recipient_latest_lid: '555@lid',
					t: '1700000000'
				},
				content: []
			},
			'111@s.whatsapp.net',
			'222@lid'
		)

		expect(lidPnMappings).toEqual([])
	})

	it('keeps incoming direct messages marked as received', () => {
		const message = decode({ id: 'incoming', from: '333@s.whatsapp.net', t: '1700000000' })

		expect(message.key).toMatchObject({ fromMe: false, remoteJid: '333@s.whatsapp.net' })
	})

	it('recognizes own messages in groups and newsletters', () => {
		const group = decode({
			id: 'group-outgoing',
			from: '123@g.us',
			participant: '111:4@s.whatsapp.net',
			t: '1700000000'
		})
		const newsletter = decode({ id: 'newsletter-outgoing', from: '111@newsletter', t: '1700000000' })

		expect(group.key.fromMe).toBe(true)
		expect(newsletter.key.fromMe).toBe(true)
	})

	it('keeps broadcast sender matching scoped to the account PN', () => {
		const message = decode(
			{ id: 'status', from: 'status@broadcast', participant: '222@lid', t: '1700000000' },
			'111@s.whatsapp.net',
			'222@lid'
		)

		expect(message.key.fromMe).toBe(false)
	})

	it('refreshes cached account JIDs when credentials change', () => {
		const repository = {} as never
		const stanza = {
			tag: 'message',
			attrs: { id: 'outgoing', from: '111@s.whatsapp.net', t: '1700000000' },
			content: []
		}

		const before = decryptMessageNode(stanza, '333@s.whatsapp.net', '444@lid', repository, undefined)
		const after = decryptMessageNode(stanza, '111@s.whatsapp.net', '444@lid', repository, undefined)

		expect(before.fullMessage.key.fromMe).toBe(false)
		expect(after.fullMessage.key.fromMe).toBe(true)
	})
})
