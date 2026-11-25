import type { USyncQueryProtocol } from '../Types/USync.js';
import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from '../Utils/logger.js';
import { USyncUser } from './USyncUser.js';
export type USyncQueryResultList = {
    [protocol: string]: unknown;
    id: string;
    privacy?: {
        token?: string;
        modeTs?: number;
    };
    isBlockedByContact?: boolean;
};
export type USyncQueryResult = {
    list: USyncQueryResultList[];
    sideList: USyncQueryResultList[];
    error?: Record<string, {
        errorCode?: number;
        errorText?: string;
        errorBackoff?: number;
    }>;
    refresh?: Record<string, number>;
};
export declare class USyncQuery {
    protocols: USyncQueryProtocol[];
    users: USyncUser[];
    context: string;
    mode: string;
    constructor();
    withMode(mode: string): this;
    withContext(context: string): this;
    withUser(user: USyncUser): this;
    parseUSyncQueryResult(result: BinaryNode | undefined, logger?: ILogger): USyncQueryResult | undefined;
    withDeviceProtocol(): this;
    withContactProtocol(): this;
    withStatusProtocol(): this;
    withDisappearingModeProtocol(): this;
    withBotProfileProtocol(): this;
    withLIDProtocol(): this;
    withUsernameProtocol(): this;
}
//# sourceMappingURL=USyncQuery.d.ts.map