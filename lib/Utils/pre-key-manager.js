import PQueue from 'p-queue';
/**
 * Manages pre-key operations with proper concurrency control
 */
export class PreKeyManager {
    constructor(store, logger) {
        this.store = store;
        this.logger = logger;
        this.queues = new Map();
    }
    /**
     * Get or create a queue for a specific key type
     */
    getQueue(keyType) {
        if (!this.queues.has(keyType)) {
            this.queues.set(keyType, new PQueue({ concurrency: 1 }));
        }
        return this.queues.get(keyType);
    }
    /**
     * Process pre-key operations (updates and deletions)
     */
    async processOperations(data, keyType, transactionCache, mutations, isInTransaction) {
        const keyData = data[keyType];
        if (!keyData)
            return;
        return this.getQueue(keyType).add(async () => {
            // Ensure structures exist
            Object.assign(transactionCache, { [keyType]: transactionCache[keyType] || {} });
            Object.assign(mutations, { [keyType]: mutations[keyType] || {} });
            // Separate deletions from updates
            const deletions = [];
            const updates = {};
            for (const keyId in keyData) {
                const value = keyData[keyId];
                if (value === null) {
                    deletions.push(keyId);
                }
                else if (value !== undefined) {
                    updates[keyId] = value;
                }
            }
            // Process updates (no validation needed)
            if (Object.keys(updates).length > 0) {
                Object.assign(transactionCache[keyType], updates);
                Object.assign(mutations[keyType], updates);
            }
            // Process deletions with validation
            if (deletions.length > 0) {
                await this.processDeletions(keyType, deletions, transactionCache, mutations, isInTransaction);
            }
        });
    }
    /**
     * Process deletions with validation
     */
    async processDeletions(keyType, ids, transactionCache, mutations, isInTransaction) {
        if (isInTransaction) {
            // In transaction, only allow deletion if key exists in cache
            for (const keyId of ids) {
                if (transactionCache[keyType]?.[keyId]) {
                    transactionCache[keyType][keyId] = null;
                    mutations[keyType][keyId] = null;
                }
                else {
                    if (this.logger)
                        this.logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`);
                }
            }
        }
        else {
            // Outside transaction, validate against store
            const existingKeys = await this.store.get(keyType, ids);
            for (const keyId of ids) {
                if (existingKeys[keyId]) {
                    transactionCache[keyType][keyId] = null;
                    mutations[keyType][keyId] = null;
                }
                else {
                    if (this.logger)
                        this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`);
                }
            }
        }
    }
    /**
     * Validate and process pre-key deletions outside transactions
     */
    async validateDeletions(data, keyType) {
        const keyData = data[keyType];
        if (!keyData)
            return;
        return this.getQueue(keyType).add(async () => {
            // Find all deletion requests
            const deletionIds = Object.keys(keyData).filter(id => keyData[id] === null);
            if (deletionIds.length === 0)
                return;
            // Validate deletions
            const existingKeys = await this.store.get(keyType, deletionIds);
            for (const keyId of deletionIds) {
                if (!existingKeys[keyId]) {
                    if (this.logger) {
                        this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`);
                    }
                    delete data[keyType][keyId];
                }
            }
        });
    }
}
//# sourceMappingURL=pre-key-manager.js.map