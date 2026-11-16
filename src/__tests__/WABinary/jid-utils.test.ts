import { describe, expect, it } from '@jest/globals'
import { areJidsSameUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../../WABinary/jid-utils'

describe('jidDecode', () => {
	it('decodes server, agent, device, and hosted domains', () => {
		expect(jidDecode('123456789@s.whatsapp.net')).toStrictEqual({
			server: 's.whatsapp.net',
			user: '123456789',
			domainType: WAJIDDomains.WHATSAPP,
			device: undefined
		})
		expect(jidDecode('123456789_128:3@hosted')).toStrictEqual({
			server: 'hosted',
			user: '123456789',
			domainType: WAJIDDomains.HOSTED,
			device: 3
		})
		expect(jidDecode('123456789:2@hosted.lid')).toStrictEqual({
			server: 'hosted.lid',
			user: '123456789',
			domainType: WAJIDDomains.HOSTED_LID,
			device: 2
		})
		expect(jidDecode('123456789_128:0@hosted')).toStrictEqual({
			server: 'hosted',
			user: '123456789',
			domainType: WAJIDDomains.HOSTED,
			device: 0
		})
	})

	it('preserves split behavior for unusual separators', () => {
		expect(jidDecode('user_7_ignored:5:ignored@c.us')).toStrictEqual({
			server: 'c.us',
			user: 'user',
			domainType: 7,
			device: 5
		})
		expect(jidDecode('user_@lid')).toStrictEqual({
			server: 'lid',
			user: 'user',
			domainType: WAJIDDomains.LID,
			device: undefined
		})
		expect(jidDecode('@')).toStrictEqual({
			server: '',
			user: '',
			domainType: WAJIDDomains.WHATSAPP,
			device: undefined
		})
	})

	it('returns undefined without a domain and normalizes c.us users', () => {
		expect(jidDecode(undefined)).toBeUndefined()
		expect(jidDecode('not-a-jid')).toBeUndefined()
		expect(jidNormalizedUser('123@s.whatsapp.net')).toBe('123@s.whatsapp.net')
		expect(jidNormalizedUser('123@lid')).toBe('123@lid')
		expect(jidNormalizedUser('123:4@c.us')).toBe('123@s.whatsapp.net')
		expect(jidNormalizedUser('123:4@s.whatsapp.net')).toBe('123@s.whatsapp.net')
		expect(jidNormalizedUser('123_5@s.whatsapp.net')).toBe('123@s.whatsapp.net')
	})
})

describe('areJidsSameUser', () => {
	it('skips parsing identical values and preserves user comparison for different JIDs', () => {
		expect(areJidsSameUser('123:4@s.whatsapp.net', '123:4@s.whatsapp.net')).toBe(true)
		expect(areJidsSameUser('123:4@s.whatsapp.net', '123:5@s.whatsapp.net')).toBe(true)
		expect(areJidsSameUser('123@s.whatsapp.net', '456@s.whatsapp.net')).toBe(false)
		expect(areJidsSameUser(undefined, undefined)).toBe(true)
	})
})
