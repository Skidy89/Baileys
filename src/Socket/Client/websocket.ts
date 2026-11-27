import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { MAX_WEBSOCKET_MESSAGE_SIZE } from '../../Utils/constants'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null
	private readonly sockets = new Set<WebSocket>()
	private connected = false

	constructor(
		url: URL,
		config: ConstructorParameters<typeof AbstractSocketClient>[1],
		private readonly fallbackUrls: URL[] = []
	) {
		super(url, config)
	}

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.sockets.size === 0
	}
	get isClosing(): boolean {
		return this.sockets.size > 0 && [...this.sockets].every(socket => socket.readyState === WebSocket.CLOSING)
	}
	get isConnecting(): boolean {
		return !this.connected && this.sockets.size > 0
	}

	connect() {
		if (this.sockets.size) {
			return
		}

		const candidates = [this.url, ...this.fallbackUrls]
		let failed = 0
		let lastError: Error | undefined
		for (const url of candidates) {
			const socket = new WebSocket(url, {
				origin: DEFAULT_ORIGIN,
				headers: this.config.options?.headers as {},
				handshakeTimeout: this.config.connectTimeoutMs,
				timeout: this.config.connectTimeoutMs,
				maxPayload: MAX_WEBSOCKET_MESSAGE_SIZE,
				agent: this.config.agent
			})
			socket.setMaxListeners(0)
			this.sockets.add(socket)
			socket.once('open', () => {
				if (this.connected) {
					socket.close(1000, 'loser socket')
					return
				}
				this.connected = true
				this.socket = socket
				for (const candidate of this.sockets) {
					if (candidate !== socket) candidate.close(1000, 'loser socket')
				}
				this.emit('open')
			})
			socket.on('close', (...args) => {
				this.sockets.delete(socket)
				if (socket === this.socket) {
					this.socket = null
					this.emit('close', ...args)
				} else if (!this.connected && ++failed === candidates.length) {
					if (lastError) this.emit('error', lastError)
					else this.emit('close', ...args)
				}
				if (!this.sockets.size) this.connected = false
			})
			socket.on('error', error => {
				if (socket === this.socket) this.emit('error', error)
				else if (!this.connected) lastError = error
			})
			for (const event of ['upgrade', 'message', 'ping', 'pong', 'unexpected-response'] as const) {
				socket.on(event, (...args) => {
					if (socket === this.socket) this.emit(event, ...args)
				})
			}
		}
	}

	pause() {
		this.socket?.pause()
	}

	resume() {
		this.socket?.resume()
	}

	async close() {
		if (!this.sockets.size) {
			this.socket = null
			this.connected = false
			return
		}

		await Promise.all(
			[...this.sockets].map(
				socket =>
					new Promise<void>(resolve => {
						if (socket.readyState === WebSocket.CLOSED) return resolve()
						socket.once('close', resolve)
						socket.close()
					})
			)
		)
		this.sockets.clear()
		this.socket = null
		this.connected = false
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}
