import { describe, expect, it, jest } from '@jest/globals'
import type { BinaryNode } from '../../WABinary'
import { makeMediaConnectionManager } from '../../Socket/messages/media-connection'

const response: BinaryNode = {
	tag: 'iq',
	attrs: {},
	content: [
		{
			tag: 'media_conn',
			attrs: { auth: 'auth', ttl: '3600' },
			content: [{ tag: 'host', attrs: { hostname: 'upload.example', maxContentLengthBytes: '1000000' } }]
		}
	]
}

describe('media connection manager', () => {
	it('shares the initial request across simultaneous refreshes', async () => {
		let resolveQuery!: (node: BinaryNode) => void
		const query = jest.fn((_node: BinaryNode) => new Promise<BinaryNode>(resolve => (resolveQuery = resolve)))
		const manager = makeMediaConnectionManager(query, undefined, 'default.example')

		const first = manager.refreshMediaConn()
		const second = manager.refreshMediaConn()
		expect(query).toHaveBeenCalledTimes(1)

		resolveQuery(response)
		const [firstInfo, secondInfo] = await Promise.all([first, second])
		expect(firstInfo).toBe(secondInfo)
		expect(firstInfo.auth).toBe('auth')
		expect(manager.getMediaHost()).toBe('upload.example')
	})

	it('retries after a failed media connection request', async () => {
		let calls = 0
		const query = async (_node: BinaryNode) => {
			if (!calls++) throw new Error('temporary failure')
			return response
		}
		const manager = makeMediaConnectionManager(query, undefined, 'default.example')

		await expect(manager.refreshMediaConn()).rejects.toThrow('temporary failure')
		await expect(manager.refreshMediaConn()).resolves.toEqual(expect.objectContaining({ auth: 'auth' }))
		expect(calls).toBe(2)
	})

	it('reuses fresh media connection data and refreshes when forced', async () => {
		const query = jest.fn(async (_node: BinaryNode) => response)
		const manager = makeMediaConnectionManager(query, undefined, 'default.example')

		await manager.refreshMediaConn()
		await manager.refreshMediaConn()
		await manager.refreshMediaConn(true)

		expect(query).toHaveBeenCalledTimes(2)
	})
})
