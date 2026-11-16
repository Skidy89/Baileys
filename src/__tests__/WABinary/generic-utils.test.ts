import { describe, expect, it } from '@jest/globals'
import { getBinaryNodeChild, getBinaryNodeChildren } from '../../WABinary/generic-utils'

describe('binary node child lookups', () => {
	it('finds the first child directly in a small node', () => {
		const first = { tag: 'item', attrs: { id: 'first' } }
		const second = { tag: 'item', attrs: { id: 'second' } }
		const node = { tag: 'list', attrs: {}, content: [first, second] }

		expect(getBinaryNodeChild(node, 'item')).toBe(first)
		expect(getBinaryNodeChild(node, 'missing')).toBeUndefined()
	})

	it('keeps indexed lookups and child ordering for larger nodes', () => {
		const children = Array.from({ length: 9 }, (_, index) => ({
			tag: index % 2 ? 'odd' : 'even',
			attrs: { id: String(index) }
		}))
		const node = { tag: 'list', attrs: {}, content: children }

		expect(getBinaryNodeChild(node, 'odd')).toBe(children[1])
		expect(getBinaryNodeChildren(node, 'odd')).toEqual([children[1], children[3], children[5], children[7]])
		expect(getBinaryNodeChild(node, 'even')).toBe(children[0])
	})

	it('does not expose the cached child index to caller mutations', () => {
		const child = { tag: 'item', attrs: { id: 'first' } }
		const node = {
			tag: 'list',
			attrs: {},
			content: Array.from({ length: 9 }, (_, index) => (index === 0 ? child : { tag: 'other', attrs: {} }))
		}

		getBinaryNodeChildren(node, 'item').pop()

		expect(getBinaryNodeChildren(node, 'item')).toEqual([child])
	})
})
