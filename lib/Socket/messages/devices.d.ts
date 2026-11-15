import type { AuthenticationState, PossiblyExtendedCacheStore } from '../../Types';
import type NodeCache from '@cacheable/node-cache';
import type { USyncQueryResult } from '../../WAUSync/USyncQuery';
import { USyncQuery } from '../../WAUSync';
import { type JidWithDevice } from '../../WABinary';
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal';
import type { Mutex } from '../../Utils/make-mutex';
import type { ILogger } from '../../Utils/logger';
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