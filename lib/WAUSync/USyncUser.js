export class USyncUser {
    constructor(logger) {
        this.logger = logger;
        this.logger?.trace('USyncUser constructed');
    }
    withDeviceHash(deviceHash) {
        this.logger?.trace('USyncUser.withDeviceHash called');
        this.deviceHash = deviceHash || undefined;
        return this;
    }
    withTs(ts) {
        this.logger?.trace('USyncUser.withTs called');
        this.ts = ts;
        return this;
    }
    withExpectedTs(expectedTs) {
        this.logger?.trace('USyncUser.withExpectedTs called');
        this.expectedTs = expectedTs;
        return this;
    }
    withId(id) {
        this.id = id;
        return this;
    }
    withLid(lid) {
        this.lid = lid;
        return this;
    }
    withPhone(phone) {
        this.phone = phone;
        return this;
    }
    withUsername(username) {
        this.username = username;
        return this;
    }
    withUsernameKey(usernameKey) {
        this.usernameKey = usernameKey;
        return this;
    }
    withType(type) {
        this.type = type;
        return this;
    }
    withPersonaId(personaId) {
        this.personaId = personaId;
        return this;
    }
}
//# sourceMappingURL=USyncUser.js.map