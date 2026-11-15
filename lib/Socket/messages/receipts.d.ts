import type { SocketConfig, WAMessageKey, MessageReceiptType } from '../../Types';
import { type BinaryNode } from '../../WABinary';
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