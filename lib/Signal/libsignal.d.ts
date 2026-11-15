import type { LIDMapping, SignalAuthState } from '../Types';
import type { SignalRepositoryWithLIDStore } from '../Types/Signal';
import type { ILogger } from '../Utils/logger';
export declare function makeLibSignalRepository(auth: SignalAuthState, logger: ILogger | undefined, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>, getUSyncDevices?: (jid: string) => Promise<string[]>): SignalRepositoryWithLIDStore;
//# sourceMappingURL=libsignal.d.ts.map