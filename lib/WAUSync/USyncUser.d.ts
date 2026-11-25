import type { ILogger } from '../Utils/logger.js';
export declare class USyncUser {
    id?: string;
    lid?: string;
    phone?: string;
    username?: string;
    usernameKey?: string;
    type?: string;
    personaId?: string;
    deviceHash?: string;
    ts?: number;
    expectedTs?: number;
    private readonly logger?;
    constructor(logger?: ILogger);
    withDeviceHash(deviceHash: string): this;
    withTs(ts: number): this;
    withExpectedTs(expectedTs: number): this;
    withId(id: string): this;
    withLid(lid: string): this;
    withPhone(phone: string): this;
    withUsername(username: string): this;
    withUsernameKey(usernameKey: string): this;
    withType(type: string): this;
    withPersonaId(personaId: string): this;
}
//# sourceMappingURL=USyncUser.d.ts.map