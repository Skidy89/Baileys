import type { ILogger } from '../Utils/logger'
import type { BinaryNode } from '../WABinary'
import type { USyncQuery } from './USyncQuery'

type USyncQueryShape = Pick<USyncQuery, 'context' | 'protocols'>

export class USyncBackoff {
	private backoffs = new Map<string, Promise<void>>()

	constructor(private logger?: ILogger) {
		this.logger?.trace({}, 'initialized USync protocol backoff')
	}

	async waitFor(query: USyncQueryShape) {
		this.logger?.trace({ context: query.context }, 'checking USync protocol backoff')
		if (query.context === 'interactive') return
		const protocolNames = query.protocols.map(({ name }) => name)
		if (protocolNames.includes('devices') && ['message', 'voip'].includes(query.context)) return
		await Promise.all(protocolNames.map(name => this.backoffs.get(name)))
	}

	record(query: USyncQueryShape, response: BinaryNode | undefined) {
		this.logger?.trace({ context: query.context }, 'recording USync protocol backoff')
		const usyncNode = Array.isArray(response?.content) ? response.content.find(node => node.tag === 'usync') : undefined
		const resultNode = Array.isArray(usyncNode?.content)
			? usyncNode.content.find(node => node.tag === 'result')
			: undefined
		for (const { name } of query.protocols) {
			const protocolNode = Array.isArray(resultNode?.content)
				? resultNode.content.find(node => node.tag === name)
				: undefined
			const errorNode = Array.isArray(protocolNode?.content)
				? protocolNode.content.find(node => node.tag === 'error')
				: undefined
			const backoff = Number(errorNode?.attrs.backoff)
			if (!Number.isFinite(backoff) || backoff <= 0) continue
			const delayMs = backoff * 1000
			const promise = new Promise<void>(resolve => setTimeout(resolve, delayMs)).then(() => {
				if (this.backoffs.get(name) === promise) this.backoffs.delete(name)
			})
			this.backoffs.set(name, promise)
			this.logger?.debug({ protocol: name, delayMs }, 'USync protocol backoff started')
		}
	}
}
