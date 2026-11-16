import { describe, expect, it, jest } from '@jest/globals'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { SignalKeyStoreWithTransaction } from '../../Types'

describe('LIDMappingStore batch lookups', () => {
	it('deduplicates database reads for multiple devices of one PN user', async () => {
		const get = jest.fn(async (_type: string, ids: string[]) =>
			Object.fromEntries(ids.map(id => [id, '999999999999999']))
		)
		const store = new LIDMappingStore({ get } as unknown as SignalKeyStoreWithTransaction, undefined)

		const mappings = await store.getLIDsForPNs(['111111111111111@s.whatsapp.net', '111111111111111:2@s.whatsapp.net'])

		expect(get).toHaveBeenCalledTimes(1)
		expect(get).toHaveBeenCalledWith('lid-mapping', ['111111111111111'])
		expect(mappings).toEqual([
			{ lid: '999999999999999@lid', pn: '111111111111111@s.whatsapp.net' },
			{ lid: '999999999999999:2@lid', pn: '111111111111111:2@s.whatsapp.net' }
		])
	})

	it('deduplicates reverse database reads for multiple devices of one LID user', async () => {
		const get = jest.fn(async (_type: string, ids: string[]) =>
			Object.fromEntries(ids.map(id => [id, '111111111111111']))
		)
		const store = new LIDMappingStore({ get } as unknown as SignalKeyStoreWithTransaction, undefined)

		const mappings = await store.getPNsForLIDs(['999999999999999@lid', '999999999999999:2@lid'])

		expect(get).toHaveBeenCalledTimes(1)
		expect(get).toHaveBeenCalledWith('lid-mapping', ['999999999999999_reverse'])
		expect(mappings).toEqual([
			{ lid: '999999999999999@lid', pn: '111111111111111:0@s.whatsapp.net' },
			{ lid: '999999999999999:2@lid', pn: '111111111111111:2@s.whatsapp.net' }
		])
	})
})
