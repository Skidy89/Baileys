import { proto } from '../../../WAProto/index.js';
import type { ILogger } from '../logger.js';
export type RichResponseFragment = {
    text: string;
} | {
    table: string[][];
    title?: string;
    hasHeader?: boolean;
} | {
    code: string;
    language?: string;
} | {
    gridImage: proto.AIRichResponseGridImageMetadata.$Properties;
} | {
    inlineImage: proto.AIRichResponseInlineImageMetadata.$Properties;
} | {
    dynamic: proto.AIRichResponseDynamicMetadata.$Properties;
} | {
    map: proto.AIRichResponseMapMetadata.$Properties;
} | {
    latex: proto.AIRichResponseLatexMetadata.$Properties;
} | {
    contentItems: proto.AIRichResponseContentItemsMetadata.$Properties;
} | {
    unknown: true;
};
export type RichResponseMessageContent = {
    richResponse: RichResponseFragment[];
    /** Additional Unified Response primitives, passed through without changing their fields. */
    unifiedPrimitives?: (Record<string, unknown> & {
        __typename: string;
    })[];
    contextInfo?: proto.IContextInfo;
    richPayload?: Pick<proto.IMessage, 'messageContextInfo'>;
};
export declare const generateRichResponseMessage: (content: RichResponseMessageContent, logger?: ILogger) => proto.IMessage;
//# sourceMappingURL=rich-response.d.ts.map