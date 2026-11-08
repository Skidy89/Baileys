import { performance } from 'node:perf_hooks'
import { decodeBinaryNode, decodeDecompressedBinaryNode, decompressingIfRequired, encodeBinaryNode } from '../src/WABinary'
import * as constants from '../src/WABinary/constants'

const iterations = Number(process.argv[2] || 20_000)
const rounds = 5
const payload = Buffer.alloc(1024, 0xa5)
const fixture = encodeBinaryNode({
	tag: 'iq',
	attrs: { id: 'bench-id', type: 'set', xmlns: 'md' },
	content: [
		{
			tag: 'pair-success',
			attrs: {},
			content: [
				{ tag: 'client-props', attrs: {}, content: payload },
				{ tag: 'device-identity', attrs: {}, content: payload },
				{
					tag: 'device',
					attrs: { jid: '1234567890:11@s.whatsapp.net', lid: '9876543210:11@lid' }
				}
			]
		}
	]
})
const legacyDecode = async () => decodeDecompressedBinaryNode(await decompressingIfRequired(fixture), constants)
const currentDecode = () => decodeBinaryNode(fixture)

const measure = async (decode: () => unknown | Promise<unknown>) => {
	const start = performance.now()
	for (let i = 0; i < iterations; i++) await decode()
	return performance.now() - start
}

for (let i = 0; i < 2_000; i++) {
	await legacyDecode()
	await currentDecode()
}

const elapsed = { legacy: [] as number[], native: [] as number[] }
for (let round = 0; round < rounds; round++) {
	const order = round % 2 === 0 ? ['legacy', 'native'] as const : ['native', 'legacy'] as const
	for (const name of order) {
		elapsed[name].push(await measure(name === 'legacy' ? legacyDecode : currentDecode))
	}
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]!
}

const summarize = (name: keyof typeof elapsed) => {
	const elapsedMs = median(elapsed[name])
	return {
		name,
		iterationsPerRound: iterations,
		rounds,
		medianElapsedMs: Number(elapsedMs.toFixed(2)),
		medianOpsPerSecond: Math.round((iterations / elapsedMs) * 1_000)
	}
}

const results = [summarize('legacy'), summarize('native')]
const [legacy, current] = results

process.stdout.write(
	`${JSON.stringify(
		{
			fixtureBytes: fixture.length,
			results,
			nativeSpeedup: Number((current!.medianOpsPerSecond / legacy!.medianOpsPerSecond).toFixed(2))
		},
		null,
		2
	)}\n`
)
