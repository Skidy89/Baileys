import type { USyncQueryProtocol } from '../Types/USync'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'
import type { ILogger } from '../Utils/logger'
import { USyncBotProfileProtocol } from './Protocols/UsyncBotProfileProtocol'
import { USyncLIDProtocol } from './Protocols/UsyncLIDProtocol'
import {
	USyncContactProtocol,
	USyncDeviceProtocol,
	USyncDisappearingModeProtocol,
	USyncStatusProtocol,
	USyncUsernameProtocol
} from './Protocols'
import { USyncUser } from './USyncUser'

export type USyncQueryResultList = {
	[protocol: string]: unknown
	id: string
	privacy?: { token?: string; modeTs?: number }
	isBlockedByContact?: boolean
}

export type USyncQueryResult = {
	list: USyncQueryResultList[]
	sideList: USyncQueryResultList[]
	error?: Record<string, { errorCode?: number; errorText?: string; errorBackoff?: number }>
	refresh?: Record<string, number>
}

export class USyncQuery {
	protocols: USyncQueryProtocol[]
	users: USyncUser[]
	context: string
	mode: string

	constructor() {
		this.protocols = []
		this.users = []
		this.context = 'interactive'
		this.mode = 'query'
	}

	withMode(mode: string) {
		this.mode = mode
		return this
	}

	withContext(context: string) {
		this.context = context
		return this
	}

	withUser(user: USyncUser) {
		this.users.push(user)
		return this
	}

	parseUSyncQueryResult(result: BinaryNode | undefined, logger?: ILogger): USyncQueryResult | undefined {
		logger?.trace({ type: result?.attrs.type }, 'parsing USync query result')
		if (result?.attrs.type !== 'result') {
			return
		}

		const protocolMap = Object.fromEntries(
			this.protocols.map(protocol => {
				return [protocol.name, protocol.parser]
			})
		)

		const queryResult: USyncQueryResult = { list: [], sideList: [], error: {}, refresh: {} }
		const protocolErrors: NonNullable<USyncQueryResult['error']> = {}
		const protocolRefresh: NonNullable<USyncQueryResult['refresh']> = {}

		const usyncNode = getBinaryNodeChild(result, 'usync')
		const resultNode = getBinaryNodeChild(usyncNode, 'result')
		for (const protocol of this.protocols) {
			const protocolResult = getBinaryNodeChild(resultNode, protocol.name)
			if (!protocolResult) continue

			const error = getBinaryNodeChild(protocolResult, 'error')
			if (error) {
				protocolErrors[protocol.name] = {
					errorCode: error.attrs.code ? +error.attrs.code : undefined,
					errorText: error.attrs.text,
					errorBackoff: error.attrs.backoff ? +error.attrs.backoff : undefined
				}
				continue
			}

			if (protocolResult.attrs.refresh) protocolRefresh[protocol.name] = +protocolResult.attrs.refresh
		}

		const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined
		const parseList = (node: BinaryNode | undefined) => {
			logger?.trace({ tag: node?.tag }, 'parsing USync result list')
			if (node?.content && Array.isArray(node.content)) {
				return node.content.reduce((acc: USyncQueryResultList[], node) => {
					const id = node?.attrs.jid
					if (id) {
						const data = Array.isArray(node?.content)
							? Object.fromEntries(
									node.content
										.map(content => {
											const protocol = content.tag
											const parser = protocolMap[protocol]
											if (parser) {
												return [protocol, parser(content)]
											} else {
												return [protocol, null]
											}
										})
										.filter(([, b]) => b !== null) as [string, unknown][]
								)
							: {}
						acc.push({ ...data, id })
					}

					return acc
				}, [])
			}
			return []
		}

		queryResult.list = parseList(listNode)
		queryResult.sideList = parseList(getBinaryNodeChild(usyncNode, 'side_list'))
		queryResult.error = protocolErrors
		queryResult.refresh = protocolRefresh

		return queryResult
	}

	withDeviceProtocol() {
		this.protocols.push(new USyncDeviceProtocol())
		return this
	}

	withContactProtocol() {
		this.protocols.push(new USyncContactProtocol())
		return this
	}

	withStatusProtocol() {
		this.protocols.push(new USyncStatusProtocol())
		return this
	}

	withDisappearingModeProtocol() {
		this.protocols.push(new USyncDisappearingModeProtocol())
		return this
	}

	withBotProfileProtocol() {
		this.protocols.push(new USyncBotProfileProtocol())
		return this
	}

	withLIDProtocol() {
		this.protocols.push(new USyncLIDProtocol())
		return this
	}

	withUsernameProtocol() {
		this.protocols.push(new USyncUsernameProtocol())
		return this
	}
}
