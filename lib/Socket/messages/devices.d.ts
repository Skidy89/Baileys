import type { AuthenticationState, PossiblyExtendedCacheStore } from '../../Types/index.js';
import type NodeCache from '@cacheable/node-cache';
import type { USyncQueryResult } from '../../WAUSync/USyncQuery.js';
import { USyncQuery } from '../../WAUSync/index.js';
import { type JidWithDevice } from '../../WABinary/index.js';
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal.js';
import type { Mutex } from '../../Utils/make-mutex.js';
import type { ILogger } from '../../Utils/logger.js';
export type DeviceWithJid = JidWithDevice & {
    jid: string;
};
type DeviceCache = NodeCache<JidWithDevice[]> | PossiblyExtendedCacheStore;
type Dependencies = {
    authState: AuthenticationState;
    userDevicesCache: DeviceCache;
    devicesMutex: Mutex;
    signalRepository: SignalRepositoryWithLIDStore;
    assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
    executeUSyncQuery: (query: USyncQuery) => Promise<USyncQueryResult | undefined>;
    logger?: ILogger;
};
export declare const makeDeviceResolver: (dependencies: Dependencies) => {
    getUSyncDevices: (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => Promise<DeviceWithJid[]>;
};
export {};
//# sourceMappingURL=devices.d.ts.map