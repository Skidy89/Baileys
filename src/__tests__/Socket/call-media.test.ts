import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { jest } from '@jest/globals'

const handleEncodedAudio = jest.fn()
const handleMicFrame = jest.fn()
const handleVideoFrame = jest.fn()
let relayOpen = false
let engineAllocated = false
const sockets: EventEmitter[] = []
const engine = {
	start: jest.fn(),
	handleMicFrame,
	handleEncodedAudio,
	handleVideoFrame,
	enableVideo: jest.fn(() => true),
	pollOutput: () => ({ kind: 0 }),
	pollTimeout: () => null,
	isAllocated: () => engineAllocated
}

jest.unstable_mockModule('@skidy89/signal-protocol', () => ({
	CallEngine: { create: () => engine },
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
	it('compensates for late microphone ticks without sending a burst after a stall', async () => {
		jest.useFakeTimers({ doNotFake: ['queueMicrotask'] })
		let now = 0
		const clock = jest.spyOn(performance, 'now').mockImplementation(() => now)
		relayOpen = engineAllocated = true
		handleMicFrame.mockClear()
		const media = new CallMediaStream({ engine: engine as never, relayIp: '127.0.0.1', relayPort: 5000 })
		try {
			await Promise.resolve()
			now = 70
			jest.advanceTimersByTime(60)
			now = 120
			jest.advanceTimersByTime(50)
			now = 400
			jest.advanceTimersByTime(60)
			jest.advanceTimersByTime(59)
			expect(handleMicFrame.mock.calls.map(([time]) => time)).toEqual([70, 120, 400])
		} finally {
			media.destroy()
			clock.mockRestore()
			jest.useRealTimers()
			engine.start.mockClear()
		}
	})
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
	it('submits 60 ms encoded packets for negotiated Opus audio', async () => {
		relayOpen = engineAllocated = true
		const media = new CallMediaStream({ audio: 'opus', relayIp: '127.0.0.1', relayPort: 5000 } as never)
		try {
			const packet = await new Promise<Buffer>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('No Opus packet')), 3000)
				handleEncodedAudio.mockImplementationOnce((_now, data) => {
					clearTimeout(timer)
					resolve(data as Buffer)
				})
				media.once('error', reject)
			})
			expect(packet.length).toBe(180)
		} finally {
			media.destroy()
		}
	})
	it('plays prepared Opus packets in order on separate microphone ticks', async () => {
		relayOpen = engineAllocated = true
		const media = new CallMediaStream({ audio: 'opus', relayIp: '127.0.0.1', relayPort: 5000 } as never)
		try {
			handleEncodedAudio.mockClear()
			const packets = Buffer.concat([Buffer.alloc(180, 1), Buffer.alloc(180, 2)])
			media.playOpusFile(packets)
			await new Promise(resolve => setTimeout(resolve, 165))
			const [first, second] = handleEncodedAudio.mock.calls
			expect(first?.[1]).toEqual(packets.subarray(0, 180))
			expect(second?.[1]).toEqual(packets.subarray(180))
			expect(Number(second?.[0]) - Number(first?.[0])).toBeGreaterThan(40)
		} finally {
			media.destroy()
		}
	})
})
