import { proto } from '../../../WAProto/index.js';
import type { AuthenticationState, SocketConfig } from '../../Types/index.js';
import { type BinaryNode } from '../../WABinary/index.js';
import type { ILogger } from '../../Utils/logger.js';
import { makeKeyedMutex } from '../../Utils/make-mutex.js';
import type { SignalRepository } from '../../Types/Signal.js';
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