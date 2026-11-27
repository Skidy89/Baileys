import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import { makeSocket } from '../../Socket/socket'
import type { SignalKeyStore, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth/utils'

describe('socket shutdown', () => {
	it('rejects pending message waiters and removes their listeners', async () => {
		const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('test WebSocket server failed to start')

		const keys: SignalKeyStore = { get: async () => ({}), set: async () => {} }
		const socket = makeSocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys },
			waWebSocketUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
			connectTimeoutMs: 250,
			defaultQueryTimeoutMs: 10_000
		} as SocketConfig)
		let pending: Promise<unknown> | undefined

		try {
			await socket.waitForSocketOpen()
			pending = socket.waitForMessage('during-close', 10_000).catch(error => error)
			await socket.end()
			expect(socket.ws.listenerCount('TAG:during-close')).toBe(0)
			await pending
		} finally {
			if (pending) {
				socket.ws.emit('error', new Error('test cleanup'))
				await pending
			}
			await socket.end()
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		}
	})
})
