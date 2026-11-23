import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) {
			return
		}

		this.socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket.setMaxListeners(0)

		this.socket.on('close', (...args) => this.emit('close', ...args))
		this.socket.on('error', (...args) => this.emit('error', ...args))
		this.socket.on('upgrade', (...args) => this.emit('upgrade', ...args))
		this.socket.on('message', (...args) => this.emit('message', ...args))
		this.socket.on('open', (...args) => this.emit('open', ...args))
		this.socket.on('ping', (...args) => this.emit('ping', ...args))
		this.socket.on('pong', (...args) => this.emit('pong', ...args))
		this.socket.on('unexpected-response', (...args) => this.emit('unexpected-response', ...args))
	}

	async close() {
		if (!this.socket) {
			return
		}

		const closePromise = new Promise<void>(resolve => {
			this.socket?.once('close', resolve)
		})

		this.socket.close()

		await closePromise

		this.socket = null
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}
