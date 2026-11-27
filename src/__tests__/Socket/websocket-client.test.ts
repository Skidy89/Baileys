import { once } from 'node:events'
import { createServer } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from '@jest/globals'
import type { SocketConfig } from '../../Types'
import { WebSocketClient } from '../../Socket/Client/websocket'

describe('WebSocketClient endpoint fallback', () => {
	it('connects through the fallback endpoint when the primary is unavailable', async () => {
		const unavailable = createServer()
		unavailable.listen(0, '127.0.0.1')
		await once(unavailable, 'listening')
		const primaryAddress = unavailable.address()
		if (!primaryAddress || typeof primaryAddress === 'string') throw new Error('test port allocation failed')
		await new Promise<void>((resolve, reject) => unavailable.close(error => (error ? reject(error) : resolve())))

		const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('test WebSocket server failed to start')
		server.on('connection', socket => socket.send('ready'))

		const primaryUrl = new URL(`ws://127.0.0.1:${primaryAddress.port}/ws`)
		const client = new WebSocketClient(primaryUrl, { connectTimeoutMs: 1_000 } as SocketConfig, [
			new URL(`ws://127.0.0.1:${address.port}/ws`)
		])
		const opened = once(client, 'open')
		const received = once(client, 'message')
		client.connect()
		try {
			await opened
			const [message] = await received
			expect(Buffer.from(message as Buffer).toString()).toBe('ready')
			expect(client.isOpen).toBe(true)
		} finally {
			await client.close()
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		}
		expect(client.isClosed).toBe(true)
	})
})
