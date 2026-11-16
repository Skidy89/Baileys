import type { MediaConnInfo } from '../../Types/index.js';
import type { ILogger } from '../../Utils/logger.js';
import { type BinaryNode } from '../../WABinary/index.js';
export declare const makeMediaConnectionManager: (query: (node: BinaryNode) => Promise<BinaryNode>, logger: ILogger | undefined, defaultMediaHost: string) => {
    refreshMediaConn: (forceGet?: boolean) => Promise<MediaConnInfo>;
    getMediaHost: () => string;
    reset: () => void;
};
//# sourceMappingURL=media-connection.d.ts.map