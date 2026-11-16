// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { CallEngine, type VoipConfig } from '@skidy89/signal-protocol'
import { Duplex, type DuplexOptions } from 'node:stream'
import { createSocket, type Socket } from 'node:dgram'
import { performance } from 'node:perf_hooks'

export type { VoipConfig, VoipOutput } from '@skidy89/signal-protocol'

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 960
const FRAME_BYTES = FRAME_SAMPLES * 2
const FRAME_MS = 60
const MAX_QUEUED_AUDIO_BYTES = SAMPLE_RATE * 2 / 2

export type CallMediaOptions = DuplexOptions & {
	/** Called for each H.264 Annex-B access unit received from the peer. */
	onVideo?: (frame: Buffer) => void
}

/**
 * UDP relay transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export class CallMediaStream extends Duplex {
	readonly #engine: CallEngine
	readonly #socket: Socket
	readonly #relay: { address: string; port: number }
	readonly #startedAt = performance.now()
	readonly #audio: Buffer[] = []
	readonly #readQueue: Buffer[] = []
	readonly #onVideo?: (frame: Buffer) => void
	#queuedBytes = 0
	#readQueueBytes = 0
	#bound = false
	#timer?: NodeJS.Timeout
	#micTimer?: NodeJS.Timeout
	#videoTimer?: NodeJS.Timeout
	#closed = false
	#videoEnabled = false
	#paused = false
	#gain = 1
	#videoFrames: Uint8Array[] = []
	#videoFrame = 0

	constructor(config: VoipConfig | { engine: CallEngine; relayIp: string; relayPort: number }, options: CallMediaOptions = {}) {
		const { onVideo, ...streamOptions } = options
		super({ ...streamOptions, allowHalfOpen: false })
		this.#engine = 'engine' in config ? config.engine : CallEngine.create(config)
		this.#relay = { address: config.relayIp, port: config.relayPort }
		this.#onVideo = onVideo
		this.#socket = createSocket(config.relayIp.includes(':') ? 'udp6' : 'udp4')
		this.#socket.on('message', (packet: Buffer) => {
			if (this.#closed) return
			this.#engine.handleRelayPacket(this.#now(), packet)
			this.#drain()
		})
		this.#socket.on('error', error => this.destroy(error))
		this.#socket.bind(0, () => {
			this.#bound = true
			if (this.#closed) {
				this.#socket.close()
				return
			}
			this.#engine.start(this.#now(), Date.now())
			this.#drain()
			this.#micTimer = setInterval(() => this.#sendAudioFrame(), FRAME_MS)
		})
	}

	get elapsedMs() {
		return this.#now()
	}

	#now() {
		return performance.now() - this.#startedAt
	}

	_read() {
		while (this.#readQueue.length) {
			const chunk = this.#readQueue.shift()!
			this.#readQueueBytes -= chunk.length
			if (!this.push(chunk)) return
		}
	}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		if (chunk.length) {
			const copy = Buffer.from(chunk)
			this.#audio.push(copy)
			this.#queuedBytes += copy.length
			while (this.#queuedBytes > MAX_QUEUED_AUDIO_BYTES) {
				const excess = this.#queuedBytes - MAX_QUEUED_AUDIO_BYTES
				const first = this.#audio[0]!
				if (first.length <= excess) {
					this.#queuedBytes -= first.length
					this.#audio.shift()
				} else {
					this.#audio[0] = first.subarray(excess + (excess % 2))
					this.#queuedBytes -= excess + (excess % 2)
				}
			}
		}
		callback()
	}

	_final(callback: (error?: Error | null) => void) {
		this.destroy()
		callback()
	}

	#sendAudioFrame() {
		if (this.#closed) return
		const frame = Buffer.alloc(FRAME_BYTES)
		let offset = 0
		while (!this.#paused && offset < frame.length && this.#audio.length) {
			const first = this.#audio[0]!
			const length = Math.min(frame.length - offset, first.length)
			first.copy(frame, offset, 0, length)
			offset += length
			this.#queuedBytes -= length
			if (length === first.length) this.#audio.shift()
			else this.#audio[0] = first.subarray(length)
		}
		const samples = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES)
		const pcm = Array.from(samples, sample => Math.max(-32768, Math.min(32767, Math.round(sample * (this.#paused ? 0 : this.#gain)))))
		this.#engine.handleMicFrame(this.#now(), pcm)
		this.#drain()
	}

	#drain() {
		if (this.#closed) return
		for (let i = 0; i < 1000; i++) {
			const output = this.#engine.pollOutput()
			if (!output.kind) break
			if (output.kind === 1 && output.data) {
				let host = this.#relay.address
				let port = this.#relay.port
				try {
					if (output.address) [host, port] = splitAddress(output.address)
				} catch (error) {
					this.destroy(error instanceof Error ? error : new Error(String(error)))
					return
				}
				this.#socket.send(output.data, port, host, error => error && this.destroy(error))
			} else if (output.kind === 2 && output.pcm?.length) {
				const pcm = Buffer.allocUnsafe(output.pcm.length * 2)
			for (let j = 0; j < output.pcm.length; j++) {
				const sample = Math.max(-32768, Math.min(32767, Math.round(output.pcm[j]!)))
				pcm.writeInt16LE(sample, j * 2)
			}
				this.#readQueue.push(pcm)
				this.#readQueueBytes += pcm.length
				while (this.#readQueueBytes > MAX_QUEUED_AUDIO_BYTES) {
					this.#readQueueBytes -= this.#readQueue.shift()!.length
				}
				this._read()
			} else if (output.kind === 3 && output.event) {
				this.emit('media-event', output.event)
			} else if (output.kind === 4 && output.data) {
				const frame = Buffer.from(output.data)
				this.#onVideo?.(frame)
				this.emit('video', frame)
			}
		}
		if (this.#timer) clearTimeout(this.#timer)
		const timeout = this.#engine.pollTimeout()
		if (timeout !== null && !this.#closed) {
			this.#timer = setTimeout(() => {
				this.#engine.handleTimeout(this.#now())
				this.#drain()
			}, Math.max(0, timeout - this.#now()))
		}
	}

	/** Send one H.264 Annex-B access unit; call `enableVideo()` first. */
	writeVideoFrame(frame: Uint8Array) {
		if (!this.#videoEnabled && !this.enableVideo()) throw new Error('This call does not support video')
		this.#engine.handleVideoFrame(this.#now(), Buffer.from(frame))
		this.#drain()
	}

	startVideoFrames(frames: Uint8Array[], fps = 15, gated = false) {
		if (!frames.length || !this.enableVideo(gated)) return false
		this.#videoFrames = frames
		this.#videoFrame = 0
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		this.#videoTimer = setInterval(() => {
			if (!this.#paused && this.#videoFrames.length) {
				this.writeVideoFrame(this.#videoFrames[this.#videoFrame % this.#videoFrames.length]!)
				this.#videoFrame++
			}
		}, Math.max(1, Math.round(1000 / Math.min(30, Math.max(1, fps)))))
		return true
	}

	releaseVideo() {
		this.#videoEnabled = this.#engine.enableVideo(false)
		this.#drain()
	}

	stopVideo() {
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		this.#videoTimer = undefined
		this.#videoFrames = []
		this.disableVideo()
	}

	pauseMedia() {
		this.#paused = true
	}

	resumeMedia() {
		this.#paused = false
	}

	clearAudio() {
		this.#audio.length = 0
		this.#queuedBytes = 0
	}

	setVolume(gain: number) {
		if (!Number.isFinite(gain) || gain < 0 || gain > 2) throw new RangeError('Call volume must be between 0 and 2')
		this.#gain = gain
	}

	get volume() {
		return this.#gain
	}

	get paused() {
		return this.#paused
	}

	get queuedSeconds() {
		return this.#queuedBytes / (SAMPLE_RATE * 2)
	}

	enableVideo(gated = false) {
		this.#videoEnabled = this.#engine.enableVideo(gated)
		this.#drain()
		return this.#videoEnabled
	}

	rekeyRecv(peerLid: string) {
		return this.#engine.rekeyRecv(peerLid)
	}

	disableVideo() {
		this.#videoEnabled = false
		this.#engine.disableVideo()
		this.#drain()
	}

	get stats() {
		return this.#engine.mediaStats()
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void) {
		this.#closed = true
		if (this.#timer) clearTimeout(this.#timer)
		if (this.#micTimer) clearInterval(this.#micTimer)
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		if (this.#bound) {
			try {
				this.#socket.close()
			} catch {
				// The UDP socket may already be closing after an error.
			}
		}
		callback(error)
	}
}

export const createCallMediaStream = (config: VoipConfig, options?: CallMediaOptions) => new CallMediaStream(config, options)
export const createCallMediaStreamFromEngine = (engine: CallEngine, relayIp: string, relayPort: number, options?: CallMediaOptions) =>
	new CallMediaStream({ engine, relayIp, relayPort }, options)

const splitAddress = (address: string): [string, number] => {
	const splitAt = address.lastIndexOf(':')
	if (splitAt < 1) throw new Error(`Invalid relay address: ${address}`)
	const port = Number(address.slice(splitAt + 1))
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid relay address: ${address}`)
	return [address.slice(0, splitAt).replace(/^\[|\]$/g, ''), port]
}
