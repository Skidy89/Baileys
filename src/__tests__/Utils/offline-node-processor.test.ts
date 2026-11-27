import { describe, expect, it } from '@jest/globals'
import type { BinaryNode } from '../../WABinary'
import { makeOfflineNodeProcessor } from '../../Utils/offline-node-processor'

describe('makeOfflineNodeProcessor', () => {
	it('preserves queued nodes and FIFO order across a closed socket', async () => {
		const count = 3000
		let isWsOpen = false
		const processed: number[] = []
		let resolveDone!: () => void
		const done = new Promise<void>(resolve => {
			resolveDone = resolve
		})
		const processor = makeOfflineNodeProcessor(
			new Map([
				[
					'message',
					async node => {
						const id = Number(node.attrs.id)
						processed.push(id)
						if (processed.length === count) resolveDone()
					}
				]
			]),
			{
				isWsOpen: () => isWsOpen,
				onUnexpectedError: error => {
					throw error
				},
				yieldToEventLoop: async () => undefined
			}
		)
		const node = (id: number) => ({ tag: 'message', attrs: { id: String(id) }, content: [] }) as BinaryNode

		processor.enqueue('message', node(1))
		processor.enqueue('message', node(2))
		isWsOpen = true
		for (let id = 3; id <= count; id++) processor.enqueue('message', node(id))
		await done

		expect(processed).toEqual(Array.from({ length: count }, (_, index) => index + 1))
	})
})
