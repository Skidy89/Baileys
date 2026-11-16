export * from './auth-types/index.js';
export * from './chats/index.js';
export * from './event-types/index.js';
export * from './groups/index.js';
export * from './labels/index.js';
export * from './messages/index.js';
export * from './products/index.js';
export * from './signal-types/index.js';
export * from './socket-types/index.js';
import type { AuthenticationState } from './auth-types/index.js';
import type { SocketConfig } from './socket-types/index.js';
export type UserFacingSocketConfig = Partial<SocketConfig> & {
    auth: AuthenticationState;
};
export type BrowsersMap = {
    ubuntu(browser: string): [string, string, string];
    macOS(browser: string): [string, string, string];
    baileys(browser: string): [string, string, string];
    windows(browser: string): [string, string, string];
    appropriate(browser: string): [string, string, string];
};
export declare enum DisconnectReason {
    connectionClosed = 428,
    connectionLost = 408,
    connectionReplaced = 440,
    timedOut = 408,
    loggedOut = 401,
    badSession = 500,
    restartRequired = 515,
    multideviceMismatch = 411,
    forbidden = 403,
    unavailableService = 503
}
export type WAInitResponse = {
    ref: string;
    ttl: number;
    status: 200;
};
export type WABusinessHoursConfig = {
    day_of_week: string;
    mode: string;
    open_time?: number;
    close_time?: number;
};
export type WABusinessProfile = {
    description: string;
    email: string | undefined;
    business_hours: {
        timezone?: string;
        config?: WABusinessHoursConfig[];
        business_config?: WABusinessHoursConfig[];
    };
    website: string[];
    category?: string;
    wid?: string;
    address?: string;
};
export type CurveKeyPair = {
    private: Uint8Array;
    public: Uint8Array;
};
//# sourceMappingURL=index.d.ts.map