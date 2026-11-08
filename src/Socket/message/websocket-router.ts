import type { BinaryNode } from '../../WABinary'

type FrameHandler = (frame: BinaryNode) => void

interface Route {
	attrKey?: string
	attrValue?: string
	childTag?: string
	handler: FrameHandler
}

export class FrameRouter {
	private readonly byId = new Map<string, FrameHandler>()
	private readonly byTag = new Map<string, Route[]>()

	onId(id: string, handler: FrameHandler) {
		this.byId.set(id, handler)
		return () => this.byId.delete(id)
	}

	onTag(tag: string, match: Omit<Route, 'handler'>, handler: FrameHandler) {
		const route: Route = { ...match, handler }
		const list = this.byTag.get(tag)
		if (list) list.push(route)
		else this.byTag.set(tag, [route])

		return () => {
			const l = this.byTag.get(tag)
			if (!l) return
			const i = l.indexOf(route)
			if (i >= 0) l.splice(i, 1)
			if (!l.length) this.byTag.delete(tag)
		}
	}

	dispatch(frame: BinaryNode): boolean {
		let handled = false
		const { tag, attrs } = frame

		const idHandler = attrs.id !== undefined ? this.byId.get(attrs.id) : undefined
		if (idHandler) {
			idHandler(frame)
			handled = true
		}

		const routes = this.byTag.get(tag)
		if (!routes) return handled

		const childTag = Array.isArray(frame.content) ? frame.content[0]?.tag : undefined

		for (const r of routes.slice()) {
			if (r.childTag !== undefined && r.childTag !== childTag) continue
			if (r.attrKey !== undefined) {
				const v = attrs[r.attrKey]
				if (v === undefined) continue
				if (r.attrValue !== undefined && v !== r.attrValue) continue
			}
			r.handler(frame)
			handled = true
		}

		return handled
	}
}
