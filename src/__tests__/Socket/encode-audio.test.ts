import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jest } from '@jest/globals'
import { encodeAudioForCall, enableEncodedAudio } from '../../Socket/features/call/encode-audio'
import type { CallState } from '../../Socket/features/call/calls'

it('queues encoded audio before acceptance and plays it directly after acceptance', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'call-opus-'))
	try {
		const file = await encodeAudioForCall('vendor/test.mp3', { dir })
		const playOpusFile = jest.fn()
		const state = { status: 'ringing', media: { playOpusFile } } as unknown as CallState
		expect(state).not.toHaveProperty('streamEncodedAudio')
		const pending = new WeakMap()
		const call = enableEncodedAudio(state, pending)
		await call.streamEncodedAudio(file)
		const packets = pending.get(call).opusFile
		expect(packets.length).toBe(file.packets * 180)
		expect(playOpusFile).not.toHaveBeenCalled()
		call.status = 'connected'
		await call.streamEncodedAudio(file.path)
		expect(playOpusFile).toHaveBeenCalledWith(packets)
		call.status = 'ended'
		await expect(call.streamEncodedAudio(file)).rejects.toThrow('unavailable')
		await writeFile(file.path, Buffer.alloc(1))
		await expect(call.streamEncodedAudio(file)).rejects.toThrow('180')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
