import { randomUUID } from 'node:crypto';
import { proto } from '../../../WAProto/index.js';
export const generateRichResponseMessage = (content, logger) => {
    const responseId = randomUUID();
    const submessages = content.richResponse.map(fragment => {
        if ('text' in fragment) {
            return { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT, messageText: fragment.text };
        }
        if ('table' in fragment) {
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TABLE,
                tableMetadata: {
                    title: fragment.title,
                    rows: fragment.table.map((items, index) => ({
                        items,
                        isHeading: fragment.hasHeader !== false && index === 0
                    }))
                }
            };
        }
        if ('code' in fragment) {
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_CODE,
                codeMetadata: {
                    codeLanguage: fragment.language || 'javascript',
                    codeBlocks: [
                        {
                            highlightType: proto.AIRichResponseCodeMetadata.AIRichResponseCodeHighlightType
                                .AI_RICH_RESPONSE_CODE_HIGHLIGHT_DEFAULT,
                            codeContent: fragment.code
                        }
                    ]
                }
            };
        }
        if ('gridImage' in fragment)
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_GRID_IMAGE,
                gridImageMetadata: fragment.gridImage
            };
        if ('inlineImage' in fragment)
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_INLINE_IMAGE,
                imageMetadata: fragment.inlineImage
            };
        if ('dynamic' in fragment)
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_DYNAMIC,
                dynamicMetadata: fragment.dynamic
            };
        if ('map' in fragment)
            return { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_MAP, mapMetadata: fragment.map };
        if ('latex' in fragment)
            return { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_LATEX, latexMetadata: fragment.latex };
        if ('contentItems' in fragment)
            return {
                messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_CONTENT_ITEMS,
                contentItemsMetadata: fragment.contentItems
            };
        return { messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_UNKNOWN };
    });
    const sections = [];
    for (const fragment of content.richResponse) {
        if ('text' in fragment) {
            sections.push({
                view_model: {
                    primitive: { text: fragment.text, inline_entities: [], __typename: 'GenAIMarkdownTextUXPrimitive' },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            });
            continue;
        }
        if ('table' in fragment) {
            sections.push({
                view_model: {
                    primitive: {
                        title: fragment.title,
                        rows: fragment.table.map((cells, index) => ({
                            is_header: fragment.hasHeader !== false && index === 0,
                            cells,
                            markdown_cells: cells.map(text => ({ text }))
                        })),
                        __typename: 'GenATableUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            });
            continue;
        }
        if ('code' in fragment) {
            sections.push({
                view_model: {
                    primitive: {
                        language: fragment.language || 'javascript',
                        code_blocks: [{ content: fragment.code, type: 'DEFAULT' }],
                        __typename: 'GenAICodeUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            });
        }
    }
    for (const primitive of content.unifiedPrimitives || []) {
        sections.push({ view_model: { primitive, __typename: 'GenAISingleLayoutViewModel' } });
    }
    const richResponse = proto.AIRichResponseMessage.create({
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        submessages,
        unifiedResponse: { data: Buffer.from(JSON.stringify({ response_id: responseId, sections })) },
        contextInfo: content.contextInfo
    });
    logger?.debug({ responseId, fragmentCount: submessages.length, unifiedPrimitiveCount: content.unifiedPrimitives?.length || 0 }, 'generating rich response message');
    return proto.Message.create({
        richResponseMessage: richResponse,
        ...content.richPayload
    });
};
//# sourceMappingURL=rich-response.js.map