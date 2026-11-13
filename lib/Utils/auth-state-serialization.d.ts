import { Packr } from 'msgpackr';
/**
 * Durable auth records use standard MessagePack maps, not msgpackr record
 * extensions. This keeps every stored value independently decodable, avoids
 * process-local structure warmup, and lets new versions read legacy record
 * extensions while migrating values through the typed SignalKeyStore API.
 */
export declare const packr: Packr;
//# sourceMappingURL=auth-state-serialization.d.ts.map