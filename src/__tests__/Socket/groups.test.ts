import { describe, expect, it } from '@jest/globals'
import { extractGroupMetadata } from '../../Socket/groups'
import type { BinaryNode } from '../../WABinary'

describe('extractGroupMetadata', () => {
	it('reads large participant lists once while preserving metadata and order', () => {
		let childReads = 0
		const content: BinaryNode[] = [
			...Array.from({ length: 50 }, (_, index) => ({
				tag: 'participant',
				attrs: { jid: `${index}@s.whatsapp.net`, type: index === 0 ? 'admin' : '' }
			})),
			{ tag: 'linked_parent', attrs: { jid: 'first@g.us' } },
			{ tag: 'linked_parent', attrs: { jid: 'second@g.us' } },
			{ tag: 'description', attrs: {}, content: [{ tag: 'body', attrs: {}, content: 'group description' }] },
			{ tag: 'ephemeral', attrs: { expiration: '3600' } },
			{ tag: 'member_add_mode', attrs: {}, content: 'all_member_add' },
			{ tag: 'locked', attrs: {} },
			{ tag: 'announcement', attrs: {} },
			{ tag: 'parent', attrs: {} },
			{ tag: 'default_sub_group', attrs: {} },
			{ tag: 'membership_approval_mode', attrs: {} }
		]
		const trackedContent = new Proxy(content, {
			get(target, property, receiver) {
				if (typeof property === 'string' && /^\d+$/.test(property)) childReads++
				return Reflect.get(target, property, receiver)
			}
		})
		const response: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: [{ tag: 'group', attrs: { id: '123@g.us', subject: 'subject' }, content: trackedContent }]
		}

		const metadata = extractGroupMetadata(response)

		expect(metadata.desc).toBe('group description')
		expect(metadata.ephemeralDuration).toBe(3600)
		expect(metadata.memberAddMode).toBe(true)
		expect(metadata.linkedParent).toBe('first@g.us')
		expect(metadata.restrict).toBe(true)
		expect(metadata.announce).toBe(true)
		expect(metadata.isCommunity).toBe(true)
		expect(metadata.isCommunityAnnounce).toBe(true)
		expect(metadata.joinApprovalMode).toBe(true)
		expect(metadata.participants.map(({ id }) => id)).toEqual(
			Array.from({ length: 50 }, (_, index) => `${index}@s.whatsapp.net`)
		)
		expect(metadata.participants[0]?.admin).toBe('admin')
		expect(childReads).toBeLessThanOrEqual(content.length * 2)
	})
})
