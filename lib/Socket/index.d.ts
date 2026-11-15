import type { UserFacingSocketConfig } from '../Types';
import { makeMessagesRecvSocket } from './messages-recv';
declare const makeWASocket: (config: UserFacingSocketConfig) => ReturnType<typeof makeMessagesRecvSocket>;
export default makeWASocket;
//# sourceMappingURL=index.d.ts.map