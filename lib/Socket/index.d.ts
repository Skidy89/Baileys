import type { UserFacingSocketConfig } from '../Types/index.js';
import { makeMessagesRecvSocket } from './messages/receive.js';
declare const makeWASocket: (config: UserFacingSocketConfig) => ReturnType<typeof makeMessagesRecvSocket>;
export default makeWASocket;
//# sourceMappingURL=index.d.ts.map