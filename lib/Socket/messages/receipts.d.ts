import type { SocketConfig, WAMessageKey, MessageReceiptType } from '../../Types/index.js';
import { type BinaryNode } from '../../WABinary/index.js';
type ReceiptDependencies = Pick<SocketConfig, 'logger'> & {
    sendNode: (node: BinaryNode) => Promise<void>;
    fetchPrivacySettings: () => Promise<{
        [_: string]: string;
    }>;
};
export declare const makeMessageReceipts: ({ logger, sendNode, fetchPrivacySettings }: ReceiptDependencies) => {
    sendReceipt: (jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => Promise<void>;
    sendReceipts: (keys: WAMessageKey[], type: MessageReceiptType) => Promise<void>;
    readMessages: (keys: WAMessageKey[]) => Promise<void>;
};
export {};
//# sourceMappingURL=receipts.d.ts.map