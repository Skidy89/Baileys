import { describe, expect, it } from '@jest/globals'
import { encodeFrame } from '@skidy89/signal-protocol'
import { Curve } from '../../Utils/crypto'
import { makeNoiseHandler } from '../../Utils/noise-handler'

describe('makeNoiseHandler', () => {
	it('decodes framed buffers passed directly to the native frame decoder', async () => {
		const noise = makeNoiseHandler({
			keyPair: Curve.generateKeyPair(),
			NOISE_HEADER: Buffer.alloc(0),
			logger: undefined
		})
		const payload = Buffer.from('payload')
		const frames: Uint8Array[] = []

		await noise.decodeFrame(encodeFrame(payload), frame => frames.push(frame))

		expect(frames).toEqual([payload])
	})
})
