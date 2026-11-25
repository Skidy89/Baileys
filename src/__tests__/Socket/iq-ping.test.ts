import { describe, expect, it, jest } from '@jest/globals'
import { buildPingIqResult } from '../../Socket/socket'
import type { ILogger } from '../../Utils/logger'

describe('WhatsApp XMPP ping response', () => {
	it('matches the official client result stanza', () => {
		const trace = jest.fn()
		const logger = { trace } as unknown as ILogger

		expect(buildPingIqResult('server@s.whatsapp.net', logger)).toEqual({
			tag: 'iq',
			attrs: { type: 'result', to: 'server@s.whatsapp.net' }
		})
		expect(trace).toHaveBeenCalledWith({ from: 'server@s.whatsapp.net' }, 'building XMPP ping result')
	})
})
