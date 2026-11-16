// velowa (https://github.com/7ucg/velowa) (c) 2026 Baron. Copying any part of this file, however small, requires credit: see LICENSE.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Readable, Writable } from 'node:stream'

export function splitAnnexB(data: Uint8Array): Uint8Array[] {
	const starts: number[] = []
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3]! & 0x1f) === 9)
			// include a leading zero byte of a 4-byte start code
			starts.push(i > 0 && data[i - 1] === 0 ? i - 1 : i)
	}
	if (!starts.length) throw new Error('no access-unit delimiters; encode with x264 aud=1')
	return starts.map((s, k) => data.subarray(s, starts[k + 1] ?? data.length))
}
// Audio and video files as call media. `ffmpeg` does the decoding: any file it reads (mp3, ogg, wav, m4a, mp4,
// mkv, ...) becomes 16 kHz mono PCM for the voice path, and a video file becomes the H.264 access units the video
// path sends. Nothing is passed through a shell, and the output is capped.

export interface MediaFileOptions {
	/** Play at most this many seconds of the file (default 600). */
	maxSeconds?: number
}

export interface QueueAudioFileOptions extends MediaFileOptions {
	signal?: AbortSignal
}

export interface VideoFileOptions extends MediaFileOptions {
	/** Frames per second to send (default 15). */
	fps?: number
	/** The picture is scaled to fit this width, keeping its aspect ratio (default 480; the height is even). */
	width?: number
}

/** Files the call options can name instead of raw audio and video. */
export interface CallFileOptions {
	/** An audio file (mp3, ogg, wav, m4a, ...) to say into the call. It plays once; silence follows. */
	audioFile?: string
	/** A video file (mp4, ...) to send as the picture, looped. Its sound plays too unless `audioFile` is given. */
	videoFile?: string
	fileOptions?: VideoFileOptions
}

export type ResolvedCallFiles = CallFileOptions & {
	audioIn?: Int16Array
	videoFrames?: Uint8Array[]
	videoFps?: number
}

const MAX_BYTES = 512 * 1024 * 1024
const AUDIO_BYTES_PER_MS = 32
const AUDIO_FRAME_BYTES = 1920

const audioQueues = new WeakMap<Writable, Promise<void>>()

/** Run ffmpeg with an argument list and collect stdout, refusing output beyond `limit` bytes. */
function ffmpeg(args: string[], limit: number): Promise<Buffer> {
	return new Promise((res, rej) => {
		const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const out: Buffer[] = []
		let size = 0
		let err = ''
		p.stdout.on('data', (b: Buffer) => {
			size += b.length
			if (size > limit) {
				p.kill('SIGKILL')
				return rej(new Error('the media file decodes to more than the allowed size'))
			}
			out.push(b)
		})
		p.stderr.on('data', (b: Buffer) => {
			if (err.length < 2000) err += b.toString()
		})
		p.on('error', (e) => rej(new Error(`ffmpeg could not be started: ${e.message}`)))
		p.on('close', (code) =>
			code === 0 ? res(Buffer.concat(out)) : rej(new Error(`ffmpeg failed: ${err.trim() || code}`)),
		)
	})
}

/** An absolute path, so a file name starting with a dash can never be read as an ffmpeg option. */
const input = (path: string): string[] => ['-i', resolve(path)]

/** Decode any audio (or the sound of a video) to 16 kHz mono PCM. */
export async function decodeAudioFile(path: string, o: MediaFileOptions = {}): Promise<Int16Array> {
	const seconds = Math.max(1, Math.min(o.maxSeconds ?? 600, 3600))
	const raw = await ffmpeg(
		[...input(path), '-vn', '-t', String(seconds), '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
		16000 * 2 * seconds + 4096,
	)
	if (!raw.length) throw new Error(`${path} has no audio`)
	const even = raw.length - (raw.length % 2)
	const copy = Buffer.from(raw.subarray(0, even))
	return new Int16Array(copy.buffer, copy.byteOffset, even >> 1)
}

/** Decode in an ffmpeg child and enqueue PCM at playback speed; calls on one stream run in order. */
export function queueAudioFile(media: Writable, source: string | Readable, o: QueueAudioFileOptions = {}): Promise<void> {
	const previous = audioQueues.get(media) ?? Promise.resolve()
	const task = previous.catch(() => undefined).then(() => streamAudioFile(media, source, o))
	audioQueues.set(media, task)
	const cleanup = () => {
		if (audioQueues.get(media) === task) audioQueues.delete(media)
	}
	task.then(cleanup, cleanup)
	return task
}

async function streamAudioFile(media: Writable, source: string | Readable, o: QueueAudioFileOptions): Promise<void> {
	if (media.destroyed) throw new Error('call media stream is closed')
	o.signal?.throwIfAborted()
	const seconds = Math.max(1, Math.min(o.maxSeconds ?? 600, 3600))
	const streamed = typeof source !== 'string'
	const p = spawn('ffmpeg', [
		'-v', 'error', '-nostdin', ...(streamed ? ['-i', 'pipe:0'] : input(source)), '-vn', '-t', String(seconds),
		'-ac', '1', '-ar', '16000', '-f', 's16le', '-'
	], { stdio: [streamed ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
	let stderr = ''
	p.stderr!.on('data', (chunk: Buffer) => {
		if (stderr.length < 2000) stderr += chunk.toString()
	})
	const exit = new Promise<{ code: number | null; error?: Error }>(resolveExit => {
		p.once('error', error => resolveExit({ code: null, error }))
		p.once('close', code => resolveExit({ code }))
	})
	const stop = () => p.kill()
	const stopOnClose = () => stop()
	o.signal?.addEventListener('abort', stop, { once: true })
	media.once('close', stopOnClose)
	const inputTask: Promise<Error | undefined> = streamed
		? pipeline(source, p.stdin!).then(() => undefined, error => {
			stop()
			return error as Error
		})
		: Promise.resolve(undefined)
	try {
		let pending = Buffer.alloc(0)
		let totalBytes = 0
		let queuedBytes = 0
		const maxBytes = 16000 * 2 * seconds + 4096
		const startedAt = performance.now()
		for await (const chunk of p.stdout!) {
			o.signal?.throwIfAborted()
			if (media.destroyed) throw new Error('call media stream is closed')
			totalBytes += chunk.length
			if (totalBytes > maxBytes) throw new Error('the media file decodes to more than the allowed size')
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
			while (pending.length >= AUDIO_FRAME_BYTES) {
				const waitMs = startedAt + queuedBytes / AUDIO_BYTES_PER_MS - performance.now()
				if (waitMs > 0) await delay(waitMs, undefined, { signal: o.signal })
				if (!media.write(pending.subarray(0, AUDIO_FRAME_BYTES))) await once(media, 'drain', { signal: o.signal })
				pending = pending.subarray(AUDIO_FRAME_BYTES)
				queuedBytes += AUDIO_FRAME_BYTES
			}
		}
		const [result, inputError] = await Promise.all([exit, inputTask])
		if (inputError && !(result.code === 0 && (inputError as NodeJS.ErrnoException).code === 'EPIPE')) throw inputError
		if (result.error) throw new Error(`ffmpeg could not be started: ${result.error.message}`)
		if (result.code !== 0) throw new Error(`ffmpeg failed: ${stderr.trim() || result.code}`)
		if (pending.length) {
			const even = pending.length - (pending.length % 2)
			if (even) {
				const waitMs = startedAt + queuedBytes / AUDIO_BYTES_PER_MS - performance.now()
				if (waitMs > 0) await delay(waitMs, undefined, { signal: o.signal })
				if (!media.write(pending.subarray(0, even))) await once(media, 'drain', { signal: o.signal })
				queuedBytes += even
			}
		}
		if (!totalBytes) throw new Error(`${typeof source === 'string' ? source : 'audio stream'} has no audio`)
	} catch (error) {
		stop()
		throw error
	} finally {
		o.signal?.removeEventListener('abort', stop)
		media.removeListener('close', stopOnClose)
	}
}

/** Decode a video to H.264 access units (Annex-B, baseline, a keyframe every two seconds). */
export async function decodeVideoFile(
	path: string,
	o: VideoFileOptions = {},
): Promise<{ frames: Uint8Array[]; fps: number }> {
	const seconds = Math.max(1, Math.min(o.maxSeconds ?? 600, 3600))
	const fps = Math.max(5, Math.min(Math.round(o.fps ?? 15), 30))
	const width = Math.max(64, Math.min(Math.round(o.width ?? 480), 1280))
	const raw = await ffmpeg(
		[
			...input(path),
			'-an',
			'-t',
			String(seconds),
			'-vf',
			`fps=${fps},scale=${width}:-2`,
			'-pix_fmt',
			'yuv420p',
			'-c:v',
			'libx264',
			'-profile:v',
			'baseline',
			'-preset',
			'veryfast',
			'-g',
			String(fps * 2),
			'-x264-params',
			'aud=1:repeat-headers=1',
			'-f',
			'h264',
			'-',
		],
		MAX_BYTES,
	)
	if (!raw.length) throw new Error(`${path} has no video`)
	return { frames: splitAnnexB(raw), fps }
}

/** Turn `audioFile` / `videoFile` into the `audioIn` / `videoFrames` the media session takes. */
export async function resolveCallFiles<T extends CallFileOptions>(o: T): Promise<T & ResolvedCallFiles> {
	if (!o.audioFile && !o.videoFile) return o
	const next: T & ResolvedCallFiles = { ...o }
	if (o.videoFile) {
		const v = await decodeVideoFile(o.videoFile, o.fileOptions)
		next.videoFrames = v.frames
		next.videoFps = v.fps
	}
	const sound = o.audioFile ?? o.videoFile
	if (sound && !(o as T & ResolvedCallFiles).audioIn) {
		try {
			next.audioIn = await decodeAudioFile(sound, o.fileOptions)
		} catch (e) {
			// A silent video is a video; an audio file with no audio is a mistake.
			if (o.audioFile) throw e
		}
	}
	return next
}
