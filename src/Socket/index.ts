import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeMessagesRecvSocket } from './messages/receive'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig): ReturnType<typeof makeMessagesRecvSocket> => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}
	if (!config.shouldSyncHistoryMessage && newConfig.syncFullHistory) {
		newConfig.shouldSyncHistoryMessage = () => true
	}

	return makeMessagesRecvSocket(newConfig)
}

export default makeWASocket
