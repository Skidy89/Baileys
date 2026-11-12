import { type BinaryNode } from '../../WABinary/index.js';
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal.js';
import type { ILogger } from '../../Utils/logger.js';
type Dependencies = {
    query: (node: BinaryNode) => Promise<BinaryNode>;
    signalRepository: SignalRepositoryWithLIDStore;
    logger?: ILogger;
};
export declare const makeSessionManager: ({ query, signalRepository, logger }: Dependencies) => {
    assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
};
export {};
//# sourceMappingURL=sessions.d.ts.map