import { proto } from '../../../WAProto/index.js';
import type { AnyMediaMessageContent, AnyMessageContent, MessageContentGenerationOptions, MessageGenerationOptions, MessageGenerationOptionsFromContent, WAMessage, WAMessageContent } from '../../Types/index.js';
type ExtractByKey<T, K extends PropertyKey> = T extends Record<K, unknown> ? T : never;
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export declare const extractUrlFromText: (text: string) => string | undefined;
export declare const generateLinkPreviewIfRequired: (text: string, getUrlInfo: MessageGenerationOptions["getUrlInfo"], logger: MessageGenerationOptions["logger"]) => Promise<import("../../Types/index.js").WAUrlInfo | undefined>;
export declare const prepareWAMessageMedia: (message: AnyMediaMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>;
export declare const prepareDisappearingMessageSettingContent: (ephemeralExpiration?: number) => proto.Message;
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export declare const generateForwardMessageContent: (message: WAMessage, forceForward?: boolean) => proto.Message.$Properties;
export declare const hasNonNullishProperty: <K extends PropertyKey>(message: AnyMessageContent, key: K) => message is ExtractByKey<AnyMessageContent, K>;
export declare const generateWAMessageContent: (message: AnyMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>;
export declare const generateWAMessageFromContent: (jid: string, message: WAMessageContent, options: MessageGenerationOptionsFromContent) => WAMessage;
export declare const generateWAMessage: (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => Promise<WAMessage>;
export {};
//# sourceMappingURL=generation.d.ts.map