// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { CallEngine, RelayChannel, type VoipConfig } from '@skidy89/signal-protocol'
import { Duplex, type DuplexOptions } from 'node:stream'
import { createSocket, type Socket } from 'node:dgram'
import { performance } from 'node:perf_hooks'

export type { VoipConfig, VoipOutput } from '@skidy89/signal-protocol'

type RelayChannelApi = RelayChannel & {
	write(now: number, data: Buffer): string | null
	pollTransmit(): Buffer | null
	pollInbound(): Buffer | null
	pollTimeout(): number
	close(now: number): void
}

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
 * RelayChannel transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export class CallMediaStream extends Duplex {
	readonly #engine: CallEngine
	readonly #channel: RelayChannelApi
	readonly #socket: Socket
	readonly #relay: { address: string; port: number }
	readonly #startedAt = performance.now()
	readonly #audio: Buffer[] = []
	readonly #readQueue: Buffer[] = []
	readonly #onVideo?: (frame: Buffer) => void
	#queuedBytes = 0
	#readQueueBytes = 0
	#bound = false
	#started = false
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
		this.#channel = new RelayChannel(config.relayIp, config.relayPort) as RelayChannelApi
		this.#onVideo = onVideo
		this.#socket = createSocket(config.relayIp.includes(':') ? 'udp6' : 'udp4')
		this.#socket.on('message', (packet: Buffer) => {
			if (this.#closed) return
			const error = this.#channel.handleDatagram(this.#now(), packet)
			if (error) return this.destroy(new Error(`Call relay: ${error}`))
			this.#drain()
		})
		this.#socket.on('error', error => this.destroy(error))
		this.#socket.bind(0, () => {
			this.#bound = true
			if (this.#closed) {
				this.#socket.close()
				return
			}
			this.#drain()
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

	#startMic() {
		if (!this.#micTimer) this.#micTimer = setInterval(() => this.#sendAudioFrame(), FRAME_MS)
	}

	#drain() {
		if (this.#closed) return
		const now = this.#now()
		for (let i = 0; i < 1000; i++) {
			let moved = false
			for (let packet = this.#channel.pollTransmit(); packet; packet = this.#channel.pollTransmit()) {
				moved = true
				this.#socket.send(packet, this.#relay.port, this.#relay.address, error => error && this.destroy(error))
			}
			if (!this.#started && this.#channel.isOpen()) {
				this.#started = true
				this.#engine.start(now, Date.now())
				moved = true
			}
			for (let packet = this.#channel.pollInbound(); packet; packet = this.#channel.pollInbound()) {
				this.#engine.handleRelayPacket(now, packet)
				moved = true
			}
			if (this.#started) {
				const output = this.#engine.pollOutput()
				if (output.kind) moved = true
				if (output.kind === 1 && output.data) {
					const error = this.#channel.write(now, output.data)
					if (error) return this.destroy(new Error(`Call relay: ${error}`))
					moved = true
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
					moved = true
				} else if (output.kind === 3 && output.event) {
					this.emit('media-event', output.event)
					if (output.event === 'MediaConnected' || output.event === 'RelayAllocated') this.#startMic()
					if (output.event === 'RelayAllocateFailed' || output.event === 'RelayAllocateTimedOut' || output.event === 'MediaSetupFailed') {
						this.destroy(new Error(`Call media setup failed: ${output.event}`))
						return
					}
				} else if (output.kind === 4 && output.data) {
					const frame = Buffer.from(output.data)
					this.#onVideo?.(frame)
					this.emit('video', frame)
					moved = true
				}
			}
			if (!moved) break
		}
		if (this.#timer) clearTimeout(this.#timer)
		const relayTimeout = this.#channel.pollTimeout()
		const engineTimeout = this.#started ? this.#engine.pollTimeout() : null
		const timeouts = [relayTimeout, engineTimeout].filter((timeout): timeout is number => timeout !== null && timeout >= 0)
		if (timeouts.length && !this.#closed) {
			this.#timer = setTimeout(() => {
				const now = this.#now()
				const error = this.#channel.handleTimeout(now)
				if (error) return this.destroy(new Error(`Call relay: ${error}`))
				if (this.#started) this.#engine.handleTimeout(now)
				this.#drain()
			}, Math.max(0, Math.min(...timeouts) - this.#now()))
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
		this.#channel.close(this.#now())
		callback(error)
	}
}

export const createCallMediaStream = (config: VoipConfig, options?: CallMediaOptions) => new CallMediaStream(config, options)
export const createCallMediaStreamFromEngine = (engine: CallEngine, relayIp: string, relayPort: number, options?: CallMediaOptions) =>
	new CallMediaStream({ engine, relayIp, relayPort }, options)

