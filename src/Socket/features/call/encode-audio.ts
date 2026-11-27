import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { ILogger } from '../../../Utils/logger'
import type { CallState } from './calls'
import type { ResolvedCallFiles } from './media-file'

// Must match CallMediaStream's pre-encoded Opus playback: 24 kbit/s CBR, 60 ms frames.
// CBR makes every packet exactly 24000 * 0.060 / 8 = 180 bytes, which playOpusFile relies on.
const OPUS_FRAME_MS = 60
const OPUS_PACKET_BYTES = 180

export interface EncodeAudioOptions {
	/** Destination folder. Created recursively if it does not exist. */
	dir: string
	/** Output name without extension. Default: the input's base name. */
	fileName?: string
	/** Re-encode even if the output already exists. Default: `true`. */
	overwrite?: boolean
	/** ffmpeg binary. Default: `ffmpeg` from PATH. */
	ffmpegPath?: string
	logger?: ILogger | undefined
}

export interface EncodedAudio {
	/** Absolute path of the encoded file (`<name>.opus.raw`, raw Opus packets with no container). */
	path: string
	packets: number
	bytes: number
	durationMs: number
}

const describe = (bytes: number): EncodedAudio => ({
	path: '',
	packets: bytes / OPUS_PACKET_BYTES,
	bytes,
	durationMs: (bytes / OPUS_PACKET_BYTES) * OPUS_FRAME_MS
})

/**
 * Converts any audio ffmpeg can read (mp3, wav, m4a, ogg, a URL...) into the packet stream
 * that `CallMediaStream.playOpusFile()` plays directly, and saves it in `dir`.
 * The call then sends this file as-is, with no real-time conversion.
 */
export async function encodeAudioForCall(input: string, options: EncodeAudioOptions): Promise<EncodedAudio> {
	const dir = resolve(options.dir)
	const name = basename(options.fileName ?? basename(input, extname(input))).replace(/[^\w.-]/g, '_')
	const path = join(dir, `${name}.opus.raw`)
	const tmp = `${path}.${randomUUID()}.tmp`
	const logger = options.logger

	mkdirSync(dir, { recursive: true })

	if (options.overwrite === false) {
		const existing = await stat(path).catch(() => undefined)
		if (existing?.size && existing.size % OPUS_PACKET_BYTES === 0) {
			logger?.debug({ path }, 'Encoded call audio already exists, reusing it')
			return { ...describe(existing.size), path }
		}
	}

	let stderr = ''
	const ffmpeg = spawn(
		options.ffmpegPath ?? 'ffmpeg',
		[
			'-nostdin',
			'-loglevel',
			'error',
			'-y',
			'-i',
			input,
			'-map',
			'0:a:0',
			'-ar',
			'16000',
			'-ac',
			'1',
			'-sample_fmt',
			's16',
			'-c:a',
			'libopus',
			'-application',
			'voip',
			'-frame_duration',
			String(OPUS_FRAME_MS),
			'-b:a',
			'24000',
			'-vbr',
			'off',
			'-f',
			'data',
			tmp
		],
		{ stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
	)
	ffmpeg.stderr.on('data', (data: Buffer) => {
		if (stderr.length < 2000) stderr += data.toString()
	})

	try {
		await new Promise<void>((resolveExit, rejectExit) => {
			ffmpeg.once('error', rejectExit) // e.g. ffmpeg is not installed
			ffmpeg.once('close', code =>
				code === 0 ? resolveExit() : rejectExit(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
			)
		})
		const { size } = await stat(tmp)
		if (!size || size % OPUS_PACKET_BYTES) {
			throw new Error(`Encoded audio is not made of ${OPUS_PACKET_BYTES}-byte packets (got ${size} bytes)`)
		}
		await rename(tmp, path)
		const result = { ...describe(size), path }
		logger?.info({ input, ...result }, 'Call audio encoded')
		return result
	} catch (error) {
		await rm(tmp, { force: true })
		logger?.error({ err: error, input }, 'Failed to encode call audio')
		throw error
	}
}

/** Reads a file made by `encodeAudioForCall`, ready for `media.playOpusFile(...)`. */
export async function readEncodedAudio(path: string): Promise<Buffer> {
	const packets = await readFile(path)
	if (!packets.length || packets.length % OPUS_PACKET_BYTES) {
		throw new Error(`${path} is not valid encoded call audio (expected a multiple of ${OPUS_PACKET_BYTES} bytes)`)
	}
	return packets
}

export function enableEncodedAudio(call: CallState, pending: WeakMap<CallState, ResolvedCallFiles>) {
	return Object.assign(call, {
		/** Schedules the file for playback on acceptance, or replaces the audio of a connected call. */
		async streamEncodedAudio(file: EncodedAudio | string) {
			const packets = await readEncodedAudio(typeof file === 'string' ? file : file.path)
			if (!call.media || call.media.destroyed || call.status === 'ended') throw new Error('Call media unavailable')
			if (call.status === 'connected') call.media.playOpusFile(packets)
			else pending.set(call, { ...pending.get(call), opusFile: packets })
		}
	})
}
