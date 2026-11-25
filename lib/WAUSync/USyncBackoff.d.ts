import type { ILogger } from '../Utils/logger.js';
import type { BinaryNode } from '../WABinary/index.js';
import type { USyncQuery } from './USyncQuery.js';
type USyncQueryShape = Pick<USyncQuery, 'context' | 'protocols'>;
export declare class USyncBackoff {
    private logger?;
    private backoffs;
    constructor(logger?: ILogger | undefined);
    waitFor(query: USyncQueryShape): Promise<void>;
    record(query: USyncQueryShape, response: BinaryNode | undefined): void;
}
export {};
//# sourceMappingURL=USyncBackoff.d.ts.map