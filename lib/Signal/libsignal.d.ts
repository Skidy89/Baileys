import type { LIDMapping, SignalAuthState } from '../Types/index.js';
import type { SignalRepositoryWithLIDStore } from '../Types/Signal.js';
import type { ILogger } from '../Utils/logger.js';
export declare function makeLibSignalRepository(auth: SignalAuthState, logger: ILogger | undefined, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>, getUSyncDevices?: (jid: string) => Promise<string[]>): SignalRepositoryWithLIDStore;
//# sourceMappingURL=libsignal.d.ts.map