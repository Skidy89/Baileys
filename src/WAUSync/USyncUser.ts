import type { ILogger } from '../Utils/logger'

export class USyncUser {
	id?: string
	lid?: string
	phone?: string
	username?: string
	usernameKey?: string
	type?: string
	personaId?: string
	deviceHash?: string
	ts?: number
	expectedTs?: number
	private readonly logger?: ILogger

	constructor(logger?: ILogger) {
		this.logger = logger
		this.logger?.trace('USyncUser constructed')
	}

	withDeviceHash(deviceHash: string) {
		this.logger?.trace('USyncUser.withDeviceHash called')
		this.deviceHash = deviceHash || undefined
		return this
	}

	withTs(ts: number) {
		this.logger?.trace('USyncUser.withTs called')
		this.ts = ts
		return this
	}

	withExpectedTs(expectedTs: number) {
		this.logger?.trace('USyncUser.withExpectedTs called')
		this.expectedTs = expectedTs
		return this
	}

	withId(id: string) {
		this.id = id
		return this
	}

	withLid(lid: string) {
		this.lid = lid
		return this
	}

	withPhone(phone: string) {
		this.phone = phone
		return this
	}

	withUsername(username: string) {
		this.username = username
		return this
	}

	withUsernameKey(usernameKey: string) {
		this.usernameKey = usernameKey
		return this
	}

	withType(type: string) {
		this.type = type
		return this
	}

	withPersonaId(personaId: string) {
		this.personaId = personaId
		return this
	}
}
