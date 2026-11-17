// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { CallEngine, RelayChannel, type VoipConfig } from '@skidy89/signal-protocol'
import { Duplex, type DuplexOptions } from 'node:stream'
import { createSocket, type Socket } from 'node:dgram'
import { performance } from 'node:perf_hooks'
import type { ILogger } from '../../../Utils/logger'

export type { VoipConfig, VoipOutput } from '@skidy89/signal-protocol'

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 960
const FRAME_MS = 60
const MAX_QUEUED_AUDIO_BYTES = (SAMPLE_RATE * 2) / 2

export type CallMediaOptions = DuplexOptions & {
	/** Called for each H.264 Annex-B access unit received from the peer. */
	onVideo?: (frame: Buffer) => void
	logger?: ILogger | undefined
}

/**
 * RelayChannel transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export class CallMediaStream extends Duplex {
	readonly #engine: CallEngine
	readonly #channel: RelayChannel
	readonly #socket: Socket
	readonly #relay: { address: string; port: number }
	readonly #startedAt = performance.now()
	readonly #audio: Buffer[] = []
	readonly #readQueue: Buffer[] = []
	readonly #onVideo?: (frame: Buffer) => void
	private logger?: ILogger | undefined
	#queuedBytes = 0
	#audioIn?: Int16Array
	#audioPos = 0
	#readQueueBytes = 0
	#bound = false
	#started = false
	#timer?: NodeJS.Timeout
	#micTimer?: NodeJS.Timeout
	#videoTimer?: NodeJS.Timeout
	#closed = false
	#connected = false
	#videoEnabled = false
	#paused = false
	#gain = 1
	#videoFrames: Uint8Array[] = []
	#videoFrame = 0
	#videoFps = 15

	constructor(
		config: VoipConfig | { engine: CallEngine; relayIp: string; relayPort: number },
		options: CallMediaOptions = {},
		logger?: ILogger | undefined
	) {
		const { onVideo, ...streamOptions } = options
		super({ ...streamOptions, allowHalfOpen: false })
		this.logger = logger ?? options.logger
		this.#engine = 'engine' in config ? config.engine : CallEngine.create(config)
		this.#relay = { address: config.relayIp, port: config.relayPort }
		this.#channel = new RelayChannel(config.relayIp, config.relayPort)
		this.#onVideo = onVideo
		this.#socket = createSocket(config.relayIp.includes(':') ? 'udp6' : 'udp4')
		this.logger?.info(
			{
				relayIp: config.relayIp,
				relayPort: config.relayPort,
				ipVersion: config.relayIp.includes(':') ? 'udp6' : 'udp4',
				engineProvided: 'engine' in config
			},
			'Call media stream created'
		)
		this.#socket.on('message', (packet: Buffer) => {
			if (this.#closed) return
			const error = this.#channel.handleDatagram(this.#now(), packet)
			if (error) {
				this.logger?.error({ error, bytes: packet.length }, 'Failed to handle relay datagram')
				return this.destroy(new Error(`Call relay: ${error}`))
			}
			this.#drain()
		})
		this.#socket.on('error', error => {
			this.logger?.error({ err: error }, 'UDP socket error')
			this.destroy(error)
		})
		this.#socket.bind(0, () => {
			this.#bound = true
			if (this.#closed) {
				this.logger?.debug('UDP socket bound after the stream was closed, closing socket')
				this.#socket.close()
				return
			}
			this.logger?.debug({ relayIp: this.#relay.address, relayPort: this.#relay.port }, 'UDP socket bound')
			this.#drain()
		})
	}

	get elapsedMs() {
		return this.#now()
	}

	get connected() {
		return this.#connected
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
			if (this.#queuedBytes > MAX_QUEUED_AUDIO_BYTES) {
				this.logger?.debug(
					{
						queuedBytes: this.#queuedBytes,
						maxBytes: MAX_QUEUED_AUDIO_BYTES,
						droppedBytes: this.#queuedBytes - MAX_QUEUED_AUDIO_BYTES
					},
					'Outgoing audio queue is full, dropping oldest audio'
				)
			}
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
		this.logger?.debug('Writable side finished, destroying call media stream')
		this.destroy()
		callback()
	}

	#sendAudioFrame() {
		if (this.#closed) return
		const frame = new Int16Array(FRAME_SAMPLES)
		if (!this.#paused && this.#audioIn) {
			const samples = this.#audioIn.subarray(this.#audioPos, this.#audioPos + FRAME_SAMPLES)
			frame.set(samples)
			this.#audioPos += samples.length
			if (this.#audioPos >= this.#audioIn.length) {
				this.#audioIn = undefined
				this.#audioPos = 0
			}
		} else if (!this.#paused) {
			const bytes = Buffer.from(frame.buffer)
			let offset = 0
			while (offset < bytes.length && this.#audio.length) {
				const first = this.#audio[0]!
				const length = Math.min(bytes.length - offset, first.length)
				first.copy(bytes, offset, 0, length)
				offset += length
				this.#queuedBytes -= length
				if (length === first.length) this.#audio.shift()
				else this.#audio[0] = first.subarray(length)
			}
		}
		const pcm = Array.from(frame, sample =>
			Math.max(-32768, Math.min(32767, Math.round(sample * (this.#paused ? 0 : this.#gain))))
		)
		this.#engine.handleMicFrame(this.#now(), pcm)
		this.#drain()
	}

	/** Queue PCM frames directly for the 60 ms microphone tick, bypassing Writable buffering. */
	speak(pcm: Int16Array, replace = false): void {
		if (replace) this.clearAudio()
		const rest = !replace && this.#audioIn ? this.#audioIn.subarray(this.#audioPos) : new Int16Array(0)
		const next = new Int16Array(rest.length + pcm.length)
		next.set(rest)
		next.set(pcm, rest.length)
		this.#audioIn = next
		this.#audioPos = 0
	}

	#startMic() {
		if (!this.#micTimer) {
			this.logger?.debug({ frameMs: FRAME_MS }, 'Starting microphone frame timer')
			this.#micTimer = setInterval(() => this.#sendAudioFrame(), FRAME_MS)
		}
	}

	#markConnected(now: number, event?: string) {
		if (this.#connected) return
		this.#connected = true
		this.logger?.info({ event: event ?? 'engine allocated', elapsedMs: now }, 'Call media connected')
		this.emit('connected')
		this.#startMic()
		this.#startVideo()
	}

	#drain() {
		if (this.#closed) return
		const now = this.#now()
		for (let i = 0; i < 1000; i++) {
			let moved = false
			for (let packet = this.#channel.pollTransmit(); packet; packet = this.#channel.pollTransmit()) {
				moved = true
				this.#socket.send(packet, this.#relay.port, this.#relay.address, error => {
					if (error) {
						this.logger?.error(
							{ err: error, relayIp: this.#relay.address, relayPort: this.#relay.port },
							'Failed to send datagram to relay'
						)
						this.destroy(error)
					}
				})
			}
			if (!this.#started && this.#channel.isOpen()) {
				this.#started = true
				this.logger?.info('Relay channel is open, starting call engine')
				this.#engine.start(now, Date.now())
				moved = true
			}
			for (let packet = this.#channel.pollInbound(); packet; packet = this.#channel.pollInbound()) {
				this.#engine.handleRelayPacket(now, packet)
				moved = true
			}
			if (this.#started && this.#engine.isAllocated()) this.#markConnected(now)
			if (this.#started) {
				const output = this.#engine.pollOutput()
				if (output.kind) moved = true
				if (output.kind === 1 && output.data) {
					const error = this.#channel.write(now, output.data)
					if (error) {
						this.logger?.error({ error }, 'Failed to write engine output to relay channel')
						return this.destroy(new Error(`Call relay: ${error}`))
					}
					moved = true
				} else if (output.kind === 2 && output.pcm?.length) {
					const pcm = Buffer.allocUnsafe(output.pcm.length * 2)
					for (let j = 0; j < output.pcm.length; j++) {
						const sample = Math.max(-32768, Math.min(32767, Math.round(output.pcm[j]!)))
						pcm.writeInt16LE(sample, j * 2)
					}
					this.#readQueue.push(pcm)
					this.#readQueueBytes += pcm.length
					if (this.#readQueueBytes > MAX_QUEUED_AUDIO_BYTES) {
						this.logger?.debug(
							{ queuedBytes: this.#readQueueBytes, maxBytes: MAX_QUEUED_AUDIO_BYTES },
							'Incoming audio queue is full, dropping oldest audio'
						)
					}
					while (this.#readQueueBytes > MAX_QUEUED_AUDIO_BYTES) {
						this.#readQueueBytes -= this.#readQueue.shift()!.length
					}
					this._read()
					moved = true
				} else if (output.kind === 3 && output.event) {
					this.logger?.info({ event: output.event }, 'Media event received')
					this.emit('media-event', output.event)
					if (output.event === 'MediaConnected' || output.event === 'RelayAllocated') {
						this.#markConnected(now, output.event)
					}
					if (
						output.event === 'RelayAllocateFailed' ||
						output.event === 'RelayAllocateTimedOut' ||
						output.event === 'MediaSetupFailed'
					) {
						this.logger?.error({ event: output.event }, 'Call media setup failed')
						this.destroy(new Error(`Call media setup failed: ${output.event}`))
						return
					}
				} else if (output.kind === 4 && output.data) {
					const frame = Buffer.from(output.data)
					this.logger?.trace({ bytes: frame.length }, 'Received video frame from peer')
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
		const timeouts = [relayTimeout, engineTimeout].filter(
			(timeout): timeout is number => timeout !== null && timeout >= 0
		)
		if (timeouts.length && !this.#closed) {
			this.#timer = setTimeout(
				() => {
					const now = this.#now()
					const error = this.#channel.handleTimeout(now)
					if (error) {
						this.logger?.error({ error }, 'Relay channel timeout handling failed')
						return this.destroy(new Error(`Call relay: ${error}`))
					}
					if (this.#started) this.#engine.handleTimeout(now)
					this.#drain()
				},
				Math.max(0, Math.min(...timeouts) - this.#now())
			)
		}
	}

	/** Send one H.264 Annex-B access unit; call `enableVideo()` first. */
	writeVideoFrame(frame: Uint8Array) {
		if (!this.#videoEnabled && !this.enableVideo()) {
			this.logger?.warn('Cannot write video frame, this call does not support video')
			throw new Error('This call does not support video')
		}
		this.logger?.trace({ bytes: frame.length }, 'Sending video frame to peer')
		this.#engine.handleVideoFrame(this.#now(), Buffer.from(frame))
		this.#drain()
	}

	startVideoFrames(frames: Uint8Array[], fps = 15, gated = false) {
		if (!frames.length) {
			this.logger?.warn('Cannot start video playback, no frames were provided')
			return false
		}
		if (!this.enableVideo(gated)) {
			this.logger?.warn({ gated }, 'Cannot start video playback, video could not be enabled')
			return false
		}
		this.logger?.info({ frames: frames.length, fps, gated }, 'Starting video frame playback')
		this.#videoFrames = frames
		this.#videoFrame = 0
		this.#videoFps = fps
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		this.#videoTimer = undefined
		this.#startVideo()
		return true
	}

	#startVideo() {
		if (!this.#connected || this.#videoTimer || !this.#videoFrames.length) return
		this.logger?.debug({ frames: this.#videoFrames.length, fps: this.#videoFps }, 'Starting video frame timer')
		this.#videoTimer = setInterval(
			() => {
				if (!this.#paused && this.#videoFrames.length) {
					this.writeVideoFrame(this.#videoFrames[this.#videoFrame % this.#videoFrames.length]!)
					this.#videoFrame++
				}
			},
			Math.max(1, Math.round(1000 / Math.min(30, Math.max(1, this.#videoFps))))
		)
	}

	releaseVideo() {
		this.logger?.debug('Releasing video')
		this.#videoEnabled = this.#engine.enableVideo(false)
		this.#drain()
	}

	stopVideo() {
		this.logger?.info('Stopping video')
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		this.#videoTimer = undefined
		this.#videoFrames = []
		this.disableVideo()
	}

	pauseMedia() {
		this.logger?.debug('Media paused')
		this.#paused = true
	}

	resumeMedia() {
		this.logger?.debug('Media resumed')
		this.#paused = false
	}

	clearAudio() {
		this.logger?.debug(
			{ clearedBytes: this.#queuedBytes, clearedSamples: this.#audioIn ? this.#audioIn.length - this.#audioPos : 0 },
			'Clearing queued outgoing audio'
		)
		this.#audio.length = 0
		this.#queuedBytes = 0
		this.#audioIn = undefined
		this.#audioPos = 0
	}

	setVolume(gain: number) {
		if (!Number.isFinite(gain) || gain < 0 || gain > 2) {
			this.logger?.warn({ gain }, 'Invalid call volume, must be between 0 and 2')
			throw new RangeError('Call volume must be between 0 and 2')
		}
		this.logger?.debug({ previous: this.#gain, gain }, 'Call volume changed')
		this.#gain = gain
	}

	get volume() {
		return this.#gain
	}

	get paused() {
		return this.#paused
	}

	get queuedSeconds() {
		return (this.#queuedBytes + (this.#audioIn ? (this.#audioIn.length - this.#audioPos) * 2 : 0)) / (SAMPLE_RATE * 2)
	}

	enableVideo(gated = false) {
		this.#videoEnabled = this.#engine.enableVideo(gated)
		this.logger?.debug({ gated, enabled: this.#videoEnabled }, 'Video enable requested')
		this.#drain()
		return this.#videoEnabled
	}

	rekeyRecv(peerLid: string) {
		const result = this.#engine.rekeyRecv(peerLid)
		this.logger?.debug({ peerLid, result }, 'Receive key rotation requested')
		return result
	}

	disableVideo() {
		this.logger?.debug('Disabling video')
		this.#videoEnabled = false
		this.#engine.disableVideo()
		this.#drain()
	}

	get stats() {
		return this.#engine.mediaStats()
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void) {
		if (error) this.logger?.error({ err: error, elapsedMs: this.#now() }, 'Call media stream destroyed with error')
		else this.logger?.info({ elapsedMs: this.#now() }, 'Call media stream destroyed')
		this.#closed = true
		if (this.#timer) clearTimeout(this.#timer)
		if (this.#micTimer) clearInterval(this.#micTimer)
		if (this.#videoTimer) clearInterval(this.#videoTimer)
		if (this.#bound) {
			try {
				this.#socket.close()
			} catch {
				// The UDP socket may already be closing after an error.
				this.logger?.debug('UDP socket was already closing')
			}
		}
		this.#channel.close(this.#now())
		callback(error)
	}
}

export const createCallMediaStream = (config: VoipConfig, options?: CallMediaOptions) =>
	new CallMediaStream(config, options)
export const createCallMediaStreamFromEngine = (
	engine: CallEngine,
	relayIp: string,
	relayPort: number,
	options?: CallMediaOptions
) => new CallMediaStream({ engine, relayIp, relayPort }, options, options?.logger)
