import { Curve } from '../../Utils/crypto'
import { makeNoiseHandler } from '../../Utils/noise-handler'
import { encodeFrame } from '@skidy89/signal-protocol'

describe('makeNoiseHandler framing', () => {
	it('encodes and decodes fragmented frames without buffering copies', async () => {
		const header = Buffer.from('WA')
		const noise = makeNoiseHandler({
			keyPair: Curve.generateKeyPair(),
			NOISE_HEADER: header,
			logger: undefined
		})
		const payload = Buffer.from([1, 2, 3, 4])
		const encoded = noise.encodeFrame(payload)
		const frames: Uint8Array[] = []

		await noise.decodeFrame(encoded.subarray(header.length, header.length + 2), frame =>
			frames.push(frame as Uint8Array)
		)
		await noise.decodeFrame(encoded.subarray(header.length + 2), frame => frames.push(frame as Uint8Array))

		expect(frames).toEqual([payload])
	})

	it('uses the native-compatible frame layout', () => {
		const header = Buffer.from('WA')
		const noise = makeNoiseHandler({
			keyPair: Curve.generateKeyPair(),
			NOISE_HEADER: header,
			logger: undefined
		})

		expect(noise.encodeFrame(Buffer.from([1, 2, 3]))).toEqual(encodeFrame(Buffer.from([1, 2, 3]), header))
	})
})
