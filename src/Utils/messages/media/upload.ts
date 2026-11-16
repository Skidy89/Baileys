import { Boom } from '@hapi/boom'
import { FastResizeFilter, ResizeFilterType, ResizeFit, Transformer } from '@napi-rs/image'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs'
import type { IAudioMetadata } from 'music-metadata'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { MEDIA_HKDF_KEY_MAPPING, type MediaType } from '../../../Defaults'
import type { MediaDecryptionKeyInfo, WAGenericMediaMessage, WAMediaUpload, WAMessageContent } from '../../../Types'
import { hkdf } from '../../crypto'
import { generateMessageID, toBufferView } from '../../generics'
import type { ILogger } from '../../logger'

const getTmpFilesDirectory = () => tmpdir()
// shortcut: tuned for concurrent Node media encryption; rebenchmark for other runtimes or storage.
const MEDIA_STREAM_CHUNK_SIZE = 1024 * 1024
// shortcut: measured faster for concurrent Node HTTP reads; rebenchmark against production networks.
const REMOTE_MEDIA_STREAM_CHUNK_SIZE = 256 * 1024
// shortcut: use Triangle above 6 MP; it wins on speed at 8 MP and on speed/RSS at 10 MP+; rebenchmark when the codec changes.
const FAST_RESIZE_MAX_PIXELS = 6_000_000

export const hkdfInfoKey = (type: MediaType) => {
	const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type]
	return `WhatsApp ${hkdfInfo} Keys`
}

export const getRawMediaUploadData = async (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => {
	const { stream } = await getStream(media)
	logger?.debug('got stream for raw upload')

	const hasher = Crypto.createHash('sha256')
	const filePath = join(tmpdir(), mediaType + generateMessageID())
	const fileWriteStream = createWriteStream(filePath)
	let fileLength = 0
	const hashStream = new Transform({
		transform(data, _, callback) {
			try {
				fileLength += data.length
				hasher.update(data)
				callback(null, data)
			} catch (error) {
				callback(error as Error)
			}
		}
	})

	try {
		await pipeline(stream, hashStream, fileWriteStream)
		stream.destroy()
		const fileSha256 = hasher.digest()
		logger?.debug('hashed data for raw upload')
		return {
			filePath: filePath,
			fileSha256,
			fileLength
		}
	} catch (error) {
		fileWriteStream.destroy()
		stream.destroy()
		try {
			await fs.unlink(filePath)
		} catch {
			//
		}

		throw error
	}
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(
	buffer: Uint8Array | string | null | undefined,
	mediaType: MediaType
): Promise<MediaDecryptionKeyInfo> {
	if (!buffer) {
		throw new Boom('Cannot derive from empty media key')
	}

	if (typeof buffer === 'string') {
		buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	}

	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.subarray(0, 16),
		cipherKey: expandedMediaKey.subarray(16, 48),
		macKey: expandedMediaKey.subarray(48, 80)
	}
}

export const extractImageThumb = async (bufferOrFilePath: Readable | Buffer | string, width = 32) => {
	if (bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath)
	}

	const input = typeof bufferOrFilePath === 'string' ? await fs.readFile(bufferOrFilePath) : bufferOrFilePath
	const image = new Transformer(input)
	const dimensions = await image.metadata()
	const buffer = await image.resize({ width, filter: ResizeFilterType.Triangle }).jpeg(50)

	return {
		buffer,
		original: {
			width: dimensions.width,
			height: dimensions.height
		}
	}
}

export const encodeBase64EncodedStringForUpload = (b64: string) =>
	encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''))

export const generateProfilePicture = async (
	mediaUpload: WAMediaUpload,
	dimensions?: { width: number; height: number }
) => {
	let buffer: Buffer

	const { width: w = 640, height: h = 640 } = dimensions || {}
	const mediaUrl = !Buffer.isBuffer(mediaUpload) && 'url' in mediaUpload ? mediaUpload.url : undefined
	const mediaUrlString = mediaUrl?.toString()

	if (Buffer.isBuffer(mediaUpload)) {
		buffer = mediaUpload
	} else if (
		mediaUrl !== undefined &&
		!mediaUrlString?.startsWith('data:') &&
		!mediaUrlString?.startsWith('http://') &&
		!mediaUrlString?.startsWith('https://')
	) {
		buffer = await fs.readFile(mediaUrl)
	} else {
		const { stream } = await getStream(mediaUpload)
		buffer = await toBuffer(stream)
	}

	const image = new Transformer(buffer)
	const { width, height } = image.metadataSync()
	const resized =
		width * height > FAST_RESIZE_MAX_PIXELS
			? image.resize({ width: w, height: h, fit: ResizeFit.Cover, filter: ResizeFilterType.Triangle })
			: image.fastResize({ width: w, height: h, fit: ResizeFit.Cover, filter: FastResizeFilter.Hamming })
	return { img: await resized.jpeg(50) }
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
	const media = Object.values(message)[0] as WAGenericMediaMessage
	return media?.fileSha256 && toBufferView(media.fileSha256).toString('base64')
}

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	const musicMetadata = await import('music-metadata')
	let metadata: IAudioMetadata
	const options = {
		duration: true
	}
	if (Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options)
	} else if (typeof buffer === 'string') {
		metadata = await musicMetadata.parseFile(buffer, options)
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options)
	}

	return metadata.format.duration
}

export const toReadable = (buffer: Buffer) => {
	let offset = 0
	return new Readable({
		highWaterMark: MEDIA_STREAM_CHUNK_SIZE,
		read() {
			const end = Math.min(offset + MEDIA_STREAM_CHUNK_SIZE, buffer.length)
			if (offset < end) {
				const chunk = buffer.subarray(offset, end)
				offset = end
				this.push(chunk)
			}

			if (offset === buffer.length) this.push(null)
		}
	})
}

// Decode aligned Base64 slices so large data URLs do not allocate one full-size Buffer.
const toBase64Readable = (base64: string) => {
	const encodedChunkSize = Math.floor(MEDIA_STREAM_CHUNK_SIZE / 3) * 4
	let offset = 0
	return new Readable({
		highWaterMark: MEDIA_STREAM_CHUNK_SIZE,
		read() {
			if (offset >= base64.length) {
				this.push(null)
				return
			}

			const end = Math.min(offset + encodedChunkSize, base64.length)
			this.push(Buffer.from(base64.slice(offset, end), 'base64'))
			offset = end
		}
	})
}

export const toBuffer = async (stream: Readable) => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}

	stream.destroy()
	return chunks.length === 1 && Buffer.isBuffer(chunks[0]) ? chunks[0] : Buffer.concat(chunks)
}

export const getStream = async (item: WAMediaUpload, opts?: RequestInit & { maxContentLength?: number }) => {
	if (Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: 'buffer' } as const
	}

	if ('stream' in item) {
		return { stream: item.stream, type: 'readable' } as const
	}

	const urlStr = item.url.toString()

	if (urlStr.startsWith('data:')) {
		const comma = urlStr.indexOf(',')
		const nextComma = urlStr.indexOf(',', comma + 1)
		const base64 = comma < 0 ? urlStr.split(',')[1]! : urlStr.slice(comma + 1, nextComma < 0 ? undefined : nextComma)
		const isChunkableBase64 =
			comma >= 0 &&
			urlStr.slice(0, comma).toLowerCase().endsWith(';base64') &&
			base64.length > MEDIA_STREAM_CHUNK_SIZE &&
			/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)
		const stream = isChunkableBase64 ? toBase64Readable(base64) : toReadable(Buffer.from(base64, 'base64'))
		return { stream, type: 'buffer' } as const
	}

	if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
		return { stream: await getHttpStream(item.url, opts), type: 'remote' } as const
	}

	return { stream: createReadStream(item.url, { highWaterMark: MEDIA_STREAM_CHUNK_SIZE }), type: 'file' } as const
}

export const getHttpStream = async (
	url: string | URL,
	options: RequestInit & { isStream?: true; timeout?: number } = {}
) => {
	const response = await fetch(url.toString(), {
		dispatcher: options.dispatcher,
		method: 'GET',
		headers: options.headers as HeadersInit,
		signal: options.signal ?? (options.timeout ? AbortSignal.timeout(options.timeout) : undefined)
	})
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined)
		throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
	}

	// @ts-ignore Node18+ Readable.fromWeb exists
	return response.body instanceof Readable
		? response.body
		: Readable.fromWeb(response.body as unknown as import('stream/web').ReadableStream, {
				highWaterMark: REMOTE_MEDIA_STREAM_CHUNK_SIZE
			})
}

type EncryptedStreamOptions = {
	saveOriginalFileIfRequired?: boolean
	logger?: ILogger
	opts?: RequestInit & { maxContentLength?: number }
	mediaKey?: Buffer
}

/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (
	file: string | Buffer,
	time: string,
	size: { width: number; height: number }
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const isBuffer = Buffer.isBuffer(file)
		const ffmpeg = execFile(
			'ffmpeg',
			[
				'-ss',
				time,
				'-i',
				isBuffer ? 'pipe:0' : file,
				'-y',
				'-vf',
				`scale=${size.width}:-1`,
				'-vframes',
				'1',
				'-f',
				'image2pipe',
				'-vcodec',
				'mjpeg',
				'pipe:1'
			],
			{ windowsHide: true, encoding: 'buffer' },
			(err, stdout) => (err ? reject(err) : resolve(stdout))
		)
		if (isBuffer) {
			ffmpeg.stdin?.on('error', () => undefined)
			ffmpeg.stdin?.end(file)
		}
	})
/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
	file: string | Buffer,
	mediaType: 'video' | 'image',
	options: {
		logger?: ILogger
	}
) {
	let thumbnail: string | undefined
	let originalImageDimensions: { width: number; height: number } | undefined
	if (mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if (original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height
			}
		}
	} else if (mediaType === 'video') {
		try {
			thumbnail = (await extractVideoThumb(file, '00:00:00', { width: 32, height: 32 })).toString('base64')
		} catch (err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	}
}

export const encryptedStream = async (
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts, mediaKey: providedKey }: EncryptedStreamOptions = {}
) => {
	logger?.debug(
		{
			mediaType,
			saveOriginalFileIfRequired
		},
		'starting media encryption'
	)
	let mac = Buffer.alloc(0)
	if (providedKey && providedKey.length !== 32) {
		throw new Boom('mediaKey must be 32 bytes', { statusCode: 400 })
	}

	const { stream, type } = await getStream(media, opts)

	logger?.debug(
		{
			type,
			mediaType
		},
		'fetched media stream'
	)
	const mediaKey = providedKey ?? Crypto.randomBytes(32)

	const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)

	const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageID() + '-enc')

	const encFileWriteStream = createWriteStream(encFilePath)

	logger?.debug(
		{
			encFilePath
		},
		'created encrypted file stream'
	)

	let originalFileStream: WriteStream | undefined
	let originalFilePath: string | undefined

	if (saveOriginalFileIfRequired) {
		originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageID() + '-original')

		originalFileStream = createWriteStream(originalFilePath)
	}

	let fileLength = 0
	let chunkCount = 0

	const maxContentLength = opts?.maxContentLength

	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)

	const hmac = Crypto.createHmac('sha256', macKey!).update(iv)

	const sha256Plain = Crypto.createHash('sha256')
	const sha256Enc = Crypto.createHash('sha256')

	const encryptTransform = new Transform({
		transform(chunk, _encoding, callback) {
			const data = Buffer.isBuffer(chunk) ? chunk : toBufferView(chunk)

			chunkCount++

			try {
				const nextLength = fileLength + data.length

				if (type === 'remote' && maxContentLength && nextLength > maxContentLength) {
					logger?.debug(
						{
							fileLength,
							chunkLength: data.length,
							maxContentLength
						},
						'maximum content length exceeded'
					)

					callback(
						new Boom(`content length exceeded when encrypting "${type}"`, {
							data: {
								media,
								type
							}
						})
					)

					return
				}

				fileLength = nextLength

				sha256Plain.update(data)

				const encrypted = aes.update(data)

				if (encrypted.length > 0) {
					sha256Enc.update(encrypted)
					hmac.update(encrypted)
				}

				if (originalFileStream) {
					if (!originalFileStream.write(data)) {
						originalFileStream.once('drain', () => {
							callback(null, encrypted)
						})

						return
					}
				}

				callback(null, encrypted)
			} catch (error) {
				logger?.error(
					{
						err: error,
						chunkCount,
						fileLength
					},
					'failed processing media chunk'
				)

				callback(error as Error)
			}
		},

		flush(callback) {
			try {
				const encrypted = aes.final()

				if (encrypted.length > 0) {
					sha256Enc.update(encrypted)
					hmac.update(encrypted)
				}

				mac = hmac.digest().subarray(0, 10)

				sha256Enc.update(mac)

				callback(null, Buffer.concat([encrypted, mac]))
			} catch (error) {
				logger?.error(
					{
						err: error
					},
					'failed finalizing encrypted stream'
				)

				callback(error as Error)
			}
		}
	})

	try {
		await pipeline(stream, encryptTransform, encFileWriteStream)

		if (originalFileStream) {
			originalFileStream.end()

			await once(originalFileStream, 'finish')
		}

		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()

		return {
			mediaKey,
			originalFilePath,
			encFilePath,
			mac,
			fileEncSha256,
			fileSha256,
			fileLength
		}
	} catch (error) {
		logger?.error(
			{
				err: error,
				mediaType,
				type,
				fileLength,
				chunkCount
			},
			'media encryption failed'
		)
		encryptTransform.destroy()
		encFileWriteStream.destroy()
		originalFileStream?.destroy()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()

		try {
			await fs.unlink(encFilePath)
		} catch (err) {
			logger?.error(
				{
					err,
					encFilePath
				},
				'failed deleting encrypted temporary file'
			)
		}

		if (originalFilePath) {
			try {
				await fs.unlink(originalFilePath)
			} catch (err) {
				logger?.error(
					{
						err,
						originalFilePath
					},
					'failed deleting original temporary file'
				)
			}
		}

		throw error
	}
}
