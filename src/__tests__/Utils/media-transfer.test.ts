import * as Crypto from 'crypto'
import { createServer } from 'http'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { downloadEncryptedContent, uploadWithNodeHttp } from '../../Utils/messages/media/transfer'
import { getHttpStream } from '../../Utils/messages/media/upload'

const chunks = (buffer: Buffer) => {
	const sizes = [1, 3, 19, 7, 32, 5]
	const result: Buffer[] = []
	for (let offset = 0, index = 0; offset < buffer.length; index++) {
		const end = Math.min(offset + sizes[index % sizes.length]!, buffer.length)
		result.push(buffer.subarray(offset, end))
		offset = end
	}
	return result
}

const collect = async (stream: Readable) => {
	const result: Buffer[] = []
	for await (const chunk of stream) result.push(chunk)
	return Buffer.concat(result)
}

describe('downloadEncryptedContent', () => {
	const key = Crypto.randomBytes(32)
	const iv = Crypto.randomBytes(16)
	const plaintext = Buffer.from(Array.from({ length: 100 }, (_, index) => index))
	const cipher = Crypto.createCipheriv('aes-256-cbc', key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), Crypto.randomBytes(10)])
	let fetchSpy: jest.SpyInstance
	let responseBody: Readable | undefined

	beforeEach(() => {
		fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			if (responseBody) return { ok: true, body: responseBody } as unknown as Response

			const range = (init?.headers as Record<string, string> | undefined)?.Range
			const [, start = '0', end] = range?.match(/bytes=(\d+)-(\d+)/) ?? []
			const bytes = encrypted.subarray(Number(start), end ? Number(end) + 1 : undefined)
			return new Response(Readable.toWeb(Readable.from(chunks(bytes))) as unknown as BodyInit)
		})
	})

	afterEach(() => {
		fetchSpy.mockRestore()
		responseBody = undefined
	})

	it('decrypts arbitrary network chunk boundaries without changing the bytes', async () => {
		const stream = await downloadEncryptedContent('https://example.test/media', { cipherKey: key, iv })

		expect(await collect(stream)).toEqual(plaintext)
	})

	it('decrypts Uint8Array chunks from a non-zero byte offset', async () => {
		const framed = Buffer.concat([Buffer.from([0xff]), encrypted, Buffer.from([0xee])])
		responseBody = Readable.from([new Uint8Array(framed.buffer, framed.byteOffset + 1, encrypted.length)])
		const stream = await downloadEncryptedContent('https://example.test/media', { cipherKey: key, iv })

		expect((await collect(stream)).equals(plaintext)).toBe(true)
	})

	it('forwards abort signals to remote media fetches', async () => {
		const signal = AbortSignal.timeout(3000)
		const stream = await getHttpStream('https://example.test/media', { signal })
		expect(stream.readableHighWaterMark).toBe(256 * 1024)

		expect(fetchSpy).toHaveBeenCalledWith('https://example.test/media', {
			dispatcher: undefined,
			method: 'GET',
			headers: undefined,
			signal
		})
		stream.destroy()
	})

	it('aborts remote media fetches at the configured timeout', async () => {
		fetchSpy.mockImplementation(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
				})
		)

		await expect(getHttpStream('https://example.test/media', { timeout: 30 })).rejects.toThrow('aborted')
	})

	it('cancels response bodies when a remote media fetch fails', async () => {
		const cancel = jest.fn()
		fetchSpy.mockResolvedValue({ ok: false, status: 404, body: new ReadableStream({ cancel }) } as unknown as Response)

		await expect(getHttpStream('https://example.test/media')).rejects.toThrow('Failed to fetch stream')
		expect(cancel).toHaveBeenCalled()
	})

	it('decrypts a requested byte range across chunk boundaries', async () => {
		const stream = await downloadEncryptedContent(
			'https://example.test/media',
			{ cipherKey: key, iv },
			{ startByte: 27, endByte: 61 }
		)

		expect(await collect(stream)).toEqual(plaintext.subarray(27, 61))
	})

	it('forwards network errors to the decrypted stream', async () => {
		const source = new Readable({ read() {} })
		responseBody = source
		const stream = await downloadEncryptedContent('https://example.test/media', { cipherKey: key, iv })
		const error = new Error('network failed')
		const streamError = new Promise<Error>(resolve => stream.once('error', resolve))

		source.destroy(error)

		await expect(streamError).resolves.toBe(error)
	})

	it('stops the network stream when the caller cancels the download', async () => {
		const source = new Readable({ read() {} })
		responseBody = source
		const stream = await downloadEncryptedContent('https://example.test/media', { cipherKey: key, iv })
		const closed = new Promise<void>(resolve => source.once('close', resolve))

		stream.destroy()

		await closed
		expect(source.destroyed).toBe(true)
	})
})

describe('uploadWithNodeHttp', () => {
	it('streams the complete file with its content length', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'baileys-upload-'))
		const filePath = join(directory, 'media.enc')
		const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 42)
		await writeFile(filePath, payload)

		let received = Buffer.alloc(0)
		let contentLength = ''
		const server = createServer((request, response) => {
			contentLength = request.headers['content-length'] || ''
			const chunks: Buffer[] = []
			request.on('data', chunk => chunks.push(Buffer.from(chunk)))
			request.on('end', () => {
				received = Buffer.concat(chunks)
				response.setHeader('content-type', 'application/json')
				response.setHeader('connection', 'close')
				response.end(JSON.stringify({ url: 'https://example.test/uploaded', direct_path: '/uploaded' }))
			})
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('local upload server failed to start')

		try {
			const result = await uploadWithNodeHttp({
				url: `http://127.0.0.1:${address.port}/upload`,
				filePath,
				headers: { 'content-type': 'application/octet-stream' }
			})

			expect(received.equals(payload)).toBe(true)
			expect(contentLength).toBe(String(payload.length))
			expect(result).toEqual({ url: 'https://example.test/uploaded', direct_path: '/uploaded' })
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
			await rm(directory, { recursive: true, force: true })
		}
	})
})
