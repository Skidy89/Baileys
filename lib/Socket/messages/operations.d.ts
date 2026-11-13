import { proto } from '../../../WAProto/index.js';
import type { MessageRelayOptions } from '../../Types';
type RelayMessage = (jid: string, message: proto.IMessage, options: MessageRelayOptions) => Promise<string>;
export declare const makeMessageOperations: (getMeId: () => string | undefined, relayMessage: RelayMessage) => {
    updateMemberLabel: (jid: string, memberLabel: string) => Promise<string>;
    sendPeerDataOperationMessage: (pdoMessage: proto.Message.IPeerDataOperationRequestMessage) => Promise<string>;
};
export {};
//# sourceMappingURL=operations.d.ts.map