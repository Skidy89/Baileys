import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { jest } from '@jest/globals'

const encoders: EventEmitter[] = []
let encoderOutput = Buffer.alloc(180, 0x7f)
const spawn = jest.fn(() => {
	const stdout = new EventEmitter()
	const child = Object.assign(new EventEmitter(), {
		stdout,
		stdin: Object.assign(new EventEmitter(), {
			writableNeedDrain: false,
			write: jest.fn((frame: Buffer) => {
				if (frame.length === 1920) queueMicrotask(() => stdout.emit('data', encoderOutput))
				return true
			}),
			destroy: jest.fn()
		}),
		kill: jest.fn()
	})
	encoders.push(child)
	return child
})

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

jest.unstable_mockModule('node:child_process', () => ({ spawn }))

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

const { CallMediaStream, createCallMediaStreamFromEngine } = await import('../../Socket/features/call/call-media')

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
	it('encodes live PCM to a complete Opus packet before the encoded engine', async () => {
		relayOpen = engineAllocated = true
		handleMicFrame.mockClear()
		handleEncodedAudio.mockClear()
		spawn.mockClear()
		encoderOutput = Buffer.alloc(180, 0x7f)
		encoders.length = 0
		const media = createCallMediaStreamFromEngine(engine as never, '127.0.0.1', 5000, undefined, 'opus')
		try {
			media.speak(new Int16Array(960).fill(1234))
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('No encoded Opus packet')), 1000)
				handleEncodedAudio.mockImplementationOnce((_now, packet) => {
					clearTimeout(timer)
					resolve()
				})
				media.once('error', reject)
			})
			expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.any(Array), expect.any(Object))
			expect(encoders[0]?.stdin.write).toHaveBeenCalledWith(expect.any(Buffer))
			expect(handleEncodedAudio.mock.calls[0]?.[1]).toEqual(Buffer.alloc(180, 0x7f))
			expect(media.audioStats.opusPacketsSubmitted).toBe(1)
			expect(handleMicFrame).not.toHaveBeenCalled()
		} finally {
			media.destroy()
			expect(encoders[0]?.stdin.destroy).toHaveBeenCalled()
			expect(encoders[0]?.kill).toHaveBeenCalled()
		}
	})
	it('keeps queued PCM when FFmpeg stdin applies backpressure', async () => {
		relayOpen = engineAllocated = true
		spawn.mockClear()
		encoders.length = 0
		const media = new CallMediaStream({ audio: 'opus', relayIp: '127.0.0.1', relayPort: 5000 } as never)
		try {
			await new Promise(resolve => setTimeout(resolve, 10))
			const stdin = (
				encoders[0] as EventEmitter & {
					stdin: { writableNeedDrain: boolean; write: jest.Mock }
				}
			).stdin
			stdin.writableNeedDrain = true
			media.speak(new Int16Array(960).fill(1234))
			await new Promise(resolve => setTimeout(resolve, 70))
			expect(stdin.write).not.toHaveBeenCalled()
			expect(media.audioStats.encoderBackpressureFrames).toBeGreaterThan(0)
			stdin.writableNeedDrain = false
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Queued PCM was not sent')), 1000)
				stdin.write.mockImplementationOnce((frame: Buffer) => {
					clearTimeout(timer)
					expect(frame.readInt16LE(0)).toBe(1234)
					resolve()
					return true
				})
			})
		} finally {
			media.destroy()
		}
	})
	it('buffers incomplete Opus output until a whole packet is available', async () => {
		relayOpen = engineAllocated = true
		encoderOutput = Buffer.alloc(179, 0x7f)
		spawn.mockClear()
		encoders.length = 0
		handleEncodedAudio.mockClear()
		const media = new CallMediaStream({ audio: 'opus', relayIp: '127.0.0.1', relayPort: 5000 } as never)
		try {
			media.speak(new Int16Array(960).fill(1234))
			await new Promise(resolve => setTimeout(resolve, 70))
			expect(handleEncodedAudio).not.toHaveBeenCalled()
			encoders[0]?.stdout.emit('data', Buffer.from([0x7f]))
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('No complete Opus packet')), 1000)
				handleEncodedAudio.mockImplementationOnce(() => {
					clearTimeout(timer)
					resolve()
				})
			})
			expect(handleEncodedAudio.mock.calls[0]?.[1]).toEqual(Buffer.alloc(180, 0x7f))
		} finally {
			media.destroy()
			encoderOutput = Buffer.alloc(180, 0x7f)
		}
	})
	it('destroys the stream and encoder on an FFmpeg process error', async () => {
		relayOpen = engineAllocated = true
		spawn.mockClear()
		encoders.length = 0
		const media = new CallMediaStream({ audio: 'opus', relayIp: '127.0.0.1', relayPort: 5000 } as never)
		const failed = new Promise<Error>(resolve => media.once('error', resolve))
		await new Promise(resolve => setTimeout(resolve, 0))
		const error = new Error('ffmpeg failed')
		encoders[0]?.emit('error', error)
		expect(await failed).toBe(error)
		expect(encoders[0]?.kill).toHaveBeenCalled()
	})
	it('keeps 16-bit PCM aligned when stream chunks split a sample', async () => {
		jest.useFakeTimers({ doNotFake: ['queueMicrotask'] })
		let now = 0
		const clock = jest.spyOn(performance, 'now').mockImplementation(() => now)
		relayOpen = engineAllocated = true
		handleMicFrame.mockClear()
		const media = new CallMediaStream({ engine: engine as never, relayIp: '127.0.0.1', relayPort: 5000 })
		try {
			media.write(Buffer.from([0x01]))
			await Promise.resolve()
			now = 60
			jest.advanceTimersByTime(60)
			media.write(Buffer.from([0x02]))
			now = 120
			jest.advanceTimersByTime(60)
			expect(handleMicFrame.mock.calls[0]?.[1]?.[0]).toBe(0)
			expect(handleMicFrame.mock.calls[1]?.[1]?.[0]).toBe(0x0201)
		} finally {
			media.destroy()
			clock.mockRestore()
			jest.useRealTimers()
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
