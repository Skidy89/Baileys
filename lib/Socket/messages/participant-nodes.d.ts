import { proto } from '../../../WAProto/index.js';
import type { AuthenticationState, SocketConfig } from '../../Types';
import { type BinaryNode } from '../../WABinary';
import type { ILogger } from '../../Utils/logger';
import { makeKeyedMutex } from '../../Utils/make-mutex';
import type { SignalRepository } from '../../Types/Signal';
type Dependencies = {
    patchMessageBeforeSending: SocketConfig['patchMessageBeforeSending'];
    authState: AuthenticationState;
    signalRepository: SignalRepository;
    encryptionMutex: ReturnType<typeof makeKeyedMutex>;
    logger?: ILogger;
};
export declare const makeParticipantNodeCreator: ({ patchMessageBeforeSending, authState, signalRepository, encryptionMutex, logger }: Dependencies) => (recipientJids: string[], message: proto.IMessage, extraAttrs?: BinaryNode["attrs"], dsmMessage?: proto.IMessage) => Promise<{
    nodes: BinaryNode[];
    shouldIncludeDeviceIdentity: boolean;
}>;
export {};
//# sourceMappingURL=participant-nodes.d.ts.map