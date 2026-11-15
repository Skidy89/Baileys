import type { MediaConnInfo } from '../../Types';
import type { ILogger } from '../../Utils/logger';
import { type BinaryNode } from '../../WABinary';
export declare const makeMediaConnectionManager: (query: (node: BinaryNode) => Promise<BinaryNode>, logger: ILogger | undefined, defaultMediaHost: string) => {
    refreshMediaConn: (forceGet?: boolean) => Promise<MediaConnInfo>;
    getMediaHost: () => string;
    reset: () => void;
};
//# sourceMappingURL=media-connection.d.ts.map