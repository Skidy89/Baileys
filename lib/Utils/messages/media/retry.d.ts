import { Boom } from '@hapi/boom';
import { proto } from '../../../../WAProto/index.js';
import type { WAMessageKey } from '../../../Types/index.js';
import { type BinaryNode } from '../../../WABinary/index.js';
/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export declare const encryptMediaRetryRequest: (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => BinaryNode;
export declare const decodeMediaRetryNode: (node: BinaryNode) => {
    key: WAMessageKey;
    media?: {
        ciphertext: Uint8Array;
        iv: Uint8Array;
    };
    error?: Boom;
};
export declare const decryptMediaRetryData: ({ ciphertext, iv }: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
}, mediaKey: Uint8Array, msgId: string) => proto.MediaRetryNotification & proto.MediaRetryNotification.$Properties;
export declare const getStatusCodeForMediaRetry: (code: number) => 200 | 412 | 404 | 418;
//# sourceMappingURL=retry.d.ts.map