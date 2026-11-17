import { EventEmitter } from 'node:events'
import { jest } from '@jest/globals'

const handleMicFrame = jest.fn()
const handleVideoFrame = jest.fn()
let relayOpen = false
let engineAllocated = false
const sockets: EventEmitter[] = []
const engine = {
	start: jest.fn(),
	handleMicFrame,
	handleVideoFrame,
	enableVideo: jest.fn(() => true),
	pollOutput: () => ({ kind: 0 }),
	pollTimeout: () => null,
	isAllocated: () => engineAllocated
}

jest.unstable_mockModule('@skidy89/signal-protocol', () => ({
	CallEngine: { create: jest.fn() },
	RelayChannel: class {
		isOpen() {
			return relayOpen
		}
		pollTransmit() {
			return null
		}
		pollInbound() {
			return null
		}
		pollTimeout() {
			return -1
		}
		handleDatagram() {
			return null
		}
		close() {}
	}
}))

jest.unstable_mockModule('node:dgram', () => ({
	createSocket: () => {
		const socket = Object.assign(new EventEmitter(), {
			bind: (_port: number, callback: () => void) => queueMicrotask(callback),
			send: (_packet: Buffer, _port: number, _address: string, callback?: (error?: Error | null) => void) =>
				callback?.(),
			close: jest.fn()
		})
		sockets.push(socket)
		return socket
	}
}))

const { CallMediaStream } = await import('../../Socket/features/call/call-media')

describe('CallMediaStream startup', () => {
	it('starts audio and video only when the engine allocates the relay', async () => {
		relayOpen = false
		engineAllocated = false
		handleMicFrame.mockClear()
		handleVideoFrame.mockClear()
		sockets.length = 0
		const media = new CallMediaStream({ engine: engine as never, relayIp: '127.0.0.1', relayPort: 5000 })
		const connected = jest.fn()
		media.speak(Int16Array.from([1234]), true)
		media.on('connected', connected)
		expect(media.connected).toBe(false)
		media.startVideoFrames([Buffer.from([1])])
		await new Promise(resolve => setTimeout(resolve, 70))
		expect(engine.start).not.toHaveBeenCalled()
		expect(handleMicFrame).not.toHaveBeenCalled()
		expect(handleVideoFrame).not.toHaveBeenCalled()
		relayOpen = true
		engineAllocated = true
		sockets[0]!.emit('message', Buffer.alloc(0))
		await new Promise(resolve => setTimeout(resolve, 70))
		expect(engine.start).toHaveBeenCalledTimes(1)
		expect(handleMicFrame).toHaveBeenCalled()
		expect(handleMicFrame.mock.calls.some(([, frame]) => frame[0] === 1234)).toBe(true)
		expect(handleVideoFrame).toHaveBeenCalled()
		expect(connected).toHaveBeenCalledTimes(1)
		expect(media.connected).toBe(true)
		media.destroy()
	})
})
