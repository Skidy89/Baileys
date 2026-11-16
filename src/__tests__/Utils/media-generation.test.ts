import { existsSync, readFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { join } from 'path'
import { describe, expect, it, jest } from '@jest/globals'
import { ResizeFilterType, ResizeFit, Transformer } from '@napi-rs/image'
import { generateWAMessageContent, prepareWAMessageMedia } from '../../Utils/messages/generation'
import {
	encryptedStream,
	extractImageThumb,
	generateProfilePicture,
	getAudioDuration,
	getRawMediaUploadData,
	getStream,
	toBuffer,
	toReadable
} from '../../Utils/messages/media/upload'

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const ffmpegIt = ffmpegAvailable ? it : it.skip

describe('prepareWAMessageMedia', () => {
	it('preserves a numeric zero status background color', async () => {
		const message = await generateWAMessageContent(
			{ text: 'status' },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				backgroundColor: 0
			}
		)

		expect(message.extendedTextMessage?.backgroundArgb).toBe(0)
	})

	it('applies the background color to push-to-talk audio', async () => {
		const message = await prepareWAMessageMedia(
			{ audio: Buffer.from('audio'), ptt: true, seconds: 1 },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				backgroundColor: '#123456'
			}
		)

		expect(message.audioMessage?.backgroundArgb).toBe(0xff123456)
	})

	it('rejects an invalid media key before fetching remote media', async () => {
		const fetchSpy = jest.spyOn(globalThis, 'fetch')
		try {
			await expect(
				encryptedStream({ url: 'https://example.test/media' }, 'image', { mediaKey: Buffer.alloc(31) })
			).rejects.toThrow('mediaKey must be 32 bytes')
			expect(fetchSpy).not.toHaveBeenCalled()
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it('reuses a single stream chunk and joins fragmented chunks', async () => {
		const single = Buffer.from('single')
		await expect(toBuffer(Readable.from([single]))).resolves.toBe(single)
		await expect(toBuffer(Readable.from([Buffer.from('one'), Buffer.from('two')]))).resolves.toEqual(
			Buffer.from('onetwo')
		)
	})

	it('streams raw newsletter media while computing its hash and length', async () => {
		const input = Buffer.from('newsletter-media')
		const result = await getRawMediaUploadData(
			{ stream: Readable.from([input.subarray(0, 4), input.subarray(4)], { objectMode: false }) },
			'image'
		)

		try {
			expect(result.fileLength).toBe(input.length)
			expect(result.fileSha256).toEqual(createHash('sha256').update(input).digest())
			expect(readFileSync(result.filePath)).toEqual(input)
		} finally {
			unlinkSync(result.filePath)
		}
	})

	it('streams large buffers in bounded chunks without changing their bytes', async () => {
		const input = Buffer.alloc(9 * 1024 * 1024, 7)
		const chunks: Buffer[] = []

		for await (const chunk of toReadable(input)) {
			expect(Buffer.isBuffer(chunk)).toBe(true)
			expect(chunk.length).toBeLessThanOrEqual(1024 * 1024)
			chunks.push(chunk)
		}

		expect(chunks.map(({ length }) => length)).toEqual(Array.from({ length: 9 }, () => 1024 * 1024))
		expect(Buffer.concat(chunks).equals(input)).toBe(true)
	})

	it('decodes data URLs without split and preserves permissive malformed base64 handling', async () => {
		const payload = Buffer.alloc(8 * 1024 * 1024 + 17, 31)
		const encoded = payload.toString('base64')
		const { stream } = await getStream({ url: `data:application/octet-stream;base64,${encoded}` })
		expect((await toBuffer(stream)).equals(payload)).toBe(true)

		const malformed = 'YQ$Yg=='
		const fallback = await getStream({ url: `data:application/octet-stream;base64,${malformed}` })
		await expect(toBuffer(fallback.stream)).resolves.toEqual(Buffer.from(malformed, 'base64'))

		const largeMalformed = `${'A'.repeat(1024 * 1024)}$AAAA`
		const largeFallback = await getStream({ url: `data:application/octet-stream;base64,${largeMalformed}` })
		expect((await toBuffer(largeFallback.stream)).equals(Buffer.from(largeMalformed, 'base64'))).toBe(true)
	})

	it('keeps encrypted media identical across source chunk sizes', async () => {
		const input = Buffer.alloc(9 * 1024 * 1024, 7)
		const fileInput = readFileSync(join(process.cwd(), 'Media', 'icon.png'))
		const mediaKey = Buffer.alloc(32, 9)
		let chunkedPath = ''
		let singleChunkPath = ''
		let fileStreamPath = ''
		let fileBufferPath = ''

		try {
			const chunked = await encryptedStream(input, 'image', { mediaKey })
			chunkedPath = chunked.encFilePath
			const singleChunk = await encryptedStream({ stream: Readable.from([input], { objectMode: false }) }, 'image', {
				mediaKey
			})
			singleChunkPath = singleChunk.encFilePath
			const fileStream = await encryptedStream({ url: join(process.cwd(), 'Media', 'icon.png') }, 'image', { mediaKey })
			fileStreamPath = fileStream.encFilePath
			const fileBuffer = await encryptedStream(fileInput, 'image', { mediaKey })
			fileBufferPath = fileBuffer.encFilePath

			expect(chunked.fileLength).toBe(singleChunk.fileLength)
			expect(chunked.fileSha256).toEqual(singleChunk.fileSha256)
			expect(chunked.fileEncSha256).toEqual(singleChunk.fileEncSha256)
			expect(chunked.mac).toEqual(singleChunk.mac)
			expect(readFileSync(chunkedPath).equals(readFileSync(singleChunkPath))).toBe(true)
			expect(fileStream.fileLength).toBe(fileBuffer.fileLength)
			expect(fileStream.fileSha256).toEqual(fileBuffer.fileSha256)
			expect(fileStream.fileEncSha256).toEqual(fileBuffer.fileEncSha256)
			expect(fileStream.mac).toEqual(fileBuffer.mac)
			expect(readFileSync(fileStreamPath).equals(readFileSync(fileBufferPath))).toBe(true)
		} finally {
			if (chunkedPath) unlinkSync(chunkedPath)
			if (singleChunkPath) unlinkSync(singleChunkPath)
			if (fileStreamPath) unlinkSync(fileStreamPath)
			if (fileBufferPath) unlinkSync(fileBufferPath)
		}
	})

	it('removes raw newsletter media when upload fails', async () => {
		let mediaPath = ''
		const failure = new Error('upload failed')
		const image = readFileSync(join(process.cwd(), 'Media', 'icon.png'))

		await expect(
			prepareWAMessageMedia(
				{ image },
				{
					jid: '123@newsletter',
					upload: async path => {
						mediaPath = path
						throw failure
					}
				}
			)
		).rejects.toBe(failure)

		expect(mediaPath).not.toBe('')
		expect(existsSync(mediaPath)).toBe(false)
	})

	it('removes the encrypted temp file when upload fails', async () => {
		let encryptedPath = ''
		const failure = new Error('upload failed')
		const image = readFileSync(join(process.cwd(), 'Media', 'icon.png'))

		await expect(
			prepareWAMessageMedia(
				{ image },
				{
					upload: async path => {
						encryptedPath = path
						throw failure
					},
					shouldProccessJpegThumbnail: true
				}
			)
		).rejects.toBe(failure)

		expect(encryptedPath).not.toBe('')
		expect(existsSync(encryptedPath)).toBe(false)
	})

	it('generates image thumbnails directly from the input buffer', async () => {
		const image = readFileSync(join(process.cwd(), 'Media', 'icon.png'))
		const message = await prepareWAMessageMedia(
			{ image },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				shouldProccessJpegThumbnail: true
			}
		)

		expect(message.imageMessage?.jpegThumbnail).toBeTruthy()
		expect(message.imageMessage?.width).toBeGreaterThan(0)
		const thumbnail = await new Transformer(Buffer.from(message.imageMessage!.jpegThumbnail!)).metadata()
		expect(thumbnail).toMatchObject({ width: 32, height: 32 })
	})

	it('generates image thumbnails directly from a local file', async () => {
		const message = await prepareWAMessageMedia(
			{ image: { url: join(process.cwd(), 'Media', 'icon.png') } },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				shouldProccessJpegThumbnail: true
			}
		)

		expect(message.imageMessage?.jpegThumbnail).toBeTruthy()
		expect(message.imageMessage?.width).toBeGreaterThan(0)
	})

	it('generates image thumbnails directly from a file URL', async () => {
		const message = await prepareWAMessageMedia(
			{ image: { url: pathToFileURL(join(process.cwd(), 'Media', 'icon.png')) } },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				shouldProccessJpegThumbnail: true
			}
		)

		expect(message.imageMessage?.jpegThumbnail).toBeTruthy()
		expect(message.imageMessage?.width).toBeGreaterThan(0)
	})

	it('keeps profile picture dimensions when using the fast resize path', async () => {
		const image = readFileSync(join(process.cwd(), 'Media', 'logo.png'))
		const { img } = await generateProfilePicture(image, { width: 64, height: 64 })
		const dimensions = await new Transformer(img).metadata()

		expect(dimensions).toMatchObject({ width: 64, height: 64 })
	})

	it('generates profile pictures directly from local files', async () => {
		const { img } = await generateProfilePicture(
			{ url: join(process.cwd(), 'Media', 'logo.png') },
			{ width: 64, height: 64 }
		)
		const dimensions = await new Transformer(img).metadata()

		expect(dimensions).toMatchObject({ width: 64, height: 64 })
	})

	it('generates profile pictures directly from file URLs', async () => {
		const file = pathToFileURL(join(process.cwd(), 'Media', 'logo.png'))
		const { img } = await generateProfilePicture({ url: file }, { width: 64, height: 64 })
		const dimensions = await new Transformer(img).metadata()

		expect(dimensions).toMatchObject({ width: 64, height: 64 })
	})

	it('uses the lower-memory resize path for images above 6 MP', async () => {
		const image = await Transformer.fromRgbaPixels(Buffer.alloc(2500 * 2500 * 4, 255), 2500, 2500).jpeg(85)
		const resize = jest.spyOn(Transformer.prototype, 'resize')
		const fastResize = jest.spyOn(Transformer.prototype, 'fastResize')
		try {
			await extractImageThumb(image)
			await generateProfilePicture(image, { width: 64, height: 64 })

			expect(resize).toHaveBeenCalledTimes(2)
			expect(resize).toHaveBeenNthCalledWith(1, { width: 32, filter: ResizeFilterType.Triangle })
			expect(resize).toHaveBeenNthCalledWith(2, {
				width: 64,
				height: 64,
				fit: ResizeFit.Cover,
				filter: ResizeFilterType.Triangle
			})
			expect(fastResize).not.toHaveBeenCalled()
		} finally {
			resize.mockRestore()
			fastResize.mockRestore()
		}
	})

	ffmpegIt('generates video thumbnails directly from the input buffer', async () => {
		const video = readFileSync(join(process.cwd(), 'Media', 'ma_gif.mp4'))
		const message = await prepareWAMessageMedia(
			{ video },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				shouldProccessJpegThumbnail: true
			}
		)

		expect(message.videoMessage?.jpegThumbnail).toBeTruthy()
	})

	ffmpegIt('generates video thumbnails directly from a local file', async () => {
		const message = await prepareWAMessageMedia(
			{ video: { url: join(process.cwd(), 'Media', 'ma_gif.mp4') } },
			{
				upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }),
				shouldProccessJpegThumbnail: true
			}
		)

		expect(message.videoMessage?.jpegThumbnail).toBeTruthy()
	})

	it('cleans the encrypted file when a buffer thumbnail fails', async () => {
		let encryptedPath = ''
		await expect(
			prepareWAMessageMedia(
				{ image: Buffer.from('not an image') },
				{
					upload: async path => {
						encryptedPath = path
						return { mediaUrl: 'https://example.test/media', directPath: '/media' }
					},
					shouldProccessJpegThumbnail: true
				}
			)
		).rejects.toThrow()

		expect(encryptedPath).not.toBe('')
		expect(existsSync(encryptedPath)).toBe(false)
	})

	it('computes audio duration from the input buffer', async () => {
		const audio = readFileSync(join(process.cwd(), 'Media', 'sonata.mp3'))
		const duration = await getAudioDuration(audio)
		const message = await prepareWAMessageMedia(
			{ audio, ptt: true },
			{ upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }) }
		)

		expect(message.audioMessage?.seconds).toBe(Math.floor(duration!))
	})

	it('computes audio duration directly from a local file', async () => {
		const audioPath = join(process.cwd(), 'Media', 'sonata.mp3')
		const duration = await getAudioDuration(audioPath)
		const message = await prepareWAMessageMedia(
			{ audio: { url: audioPath }, ptt: true },
			{ upload: async () => ({ mediaUrl: 'https://example.test/media', directPath: '/media' }) }
		)

		expect(message.audioMessage?.seconds).toBe(Math.floor(duration!))
	})
})
