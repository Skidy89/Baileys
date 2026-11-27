import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeMessagesRecvSocket } from './messages/receive.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    if (!config.shouldSyncHistoryMessage && newConfig.syncFullHistory) {
        newConfig.shouldSyncHistoryMessage = () => true;
    }
    return makeMessagesRecvSocket(newConfig);
};
export default makeWASocket;
//# sourceMappingURL=index.js.map