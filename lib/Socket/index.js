import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeMessagesRecvSocket } from './messages-recv.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    return makeMessagesRecvSocket(newConfig);
};
export default makeWASocket;
//# sourceMappingURL=index.js.map