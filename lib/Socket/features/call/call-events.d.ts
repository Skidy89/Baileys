import type { WACallEvent } from '../../../Types/index.js';
import type { BinaryNode } from '../../../WABinary/index.js';
export declare const parseCall: (node: BinaryNode) => WACallEvent | undefined;
export declare const callAckOrReceipt: (node: BinaryNode) => BinaryNode | undefined;
export declare const callReceipt: (node: BinaryNode) => BinaryNode | undefined;
export declare const rejectCallNode: (callId: string, to: string, creator: string, id: string) => BinaryNode;
export declare const terminateCallNode: (callId: string, to: string, creator: string, id: string) => BinaryNode;
//# sourceMappingURL=call-events.d.ts.map