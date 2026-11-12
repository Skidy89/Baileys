import type { BinaryNode } from '../../WABinary';
type FrameHandler = (frame: BinaryNode) => void;
interface Route {
    attrKey?: string;
    attrValue?: string;
    childTag?: string;
    handler: FrameHandler;
}
export declare class FrameRouter {
    private readonly byId;
    private readonly byTag;
    onId(id: string, handler: FrameHandler): () => boolean;
    onTag(tag: string, match: Omit<Route, 'handler'>, handler: FrameHandler): () => void;
    dispatch(frame: BinaryNode): boolean;
}
export {};
//# sourceMappingURL=websocket-router.d.ts.map