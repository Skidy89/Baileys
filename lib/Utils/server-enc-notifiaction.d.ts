import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
export type ServerEncryptNotificationResult = {
    action: 'in_flight';
} | {
    action: 'prekey_count';
    count: number;
    uploaded: boolean;
} | {
    action: 'digest_ok';
} | {
    action: 'digest_missing_uploaded';
} | {
    action: 'digest_failed';
    code?: number;
} | {
    action: 'pq_count_ignored';
} | {
    action: 'unknown';
};
export type ServerEncryptNotificationContext = {
    query: (node: BinaryNode) => Promise<unknown>;
    uploadPreKeys: () => Promise<void>;
    inFlightPreKeyLow: Set<string>;
    logger: ILogger | undefined;
};
/**
 * Handles `<notification type="encrypt" from="s.whatsapp.net">`.
 *
 * The server sends three variants, mirroring WA Web:
 * - `<count>`: our pre-key count is low; upload more (WAWebHandlePreKeyLow).
 * - `<pq_count>`: post-quantum (Kyber) pre-key count; WA Web only acks it unless
 *   PQ upload is enabled, which Baileys does not support.
 * - `<digest>`: the server asks us to validate our key bundle (WAWebHandleDigestKey /
 *   WAWebDigestKeyJob): an `encrypt` iq with `<digest/>`; if the server has no record
 *   for us (404) the pre-keys are uploaded again. Other errors are only logged.
 *
 * Previously only `<count>` was handled and the other two crashed on `countChild.attrs`.
 */
export declare function handleServerEncryptNotification(node: BinaryNode, ctx: ServerEncryptNotificationContext): Promise<ServerEncryptNotificationResult>;
//# sourceMappingURL=server-enc-notifiaction.d.ts.map