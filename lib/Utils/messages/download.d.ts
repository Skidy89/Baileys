import type { Transform } from 'stream';
import { proto } from '../../../WAProto/index.js';
import type { WAMessage } from '../../Types/index.js';
import { type MediaDownloadOptions } from './media/index.js';
import type { ILogger } from '../logger.js';
type DownloadMediaMessageContext = {
    reuploadRequest: (msg: WAMessage) => Promise<WAMessage>;
    logger: ILogger;
};
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export declare const downloadMediaMessage: <Type extends "buffer" | "stream">(message: WAMessage, type: Type, options: MediaDownloadOptions, ctx?: DownloadMediaMessageContext) => Promise<Type extends "buffer" ? Buffer<ArrayBufferLike> : Transform>;
/** Checks whether the given message is a media message; if it is returns the inner content */
export declare const assertMediaContent: (content: proto.IMessage | null | undefined) => proto.Message.ImageMessage.$Properties | proto.Message.DocumentMessage.$Properties | proto.Message.AudioMessage.$Properties | proto.Message.VideoMessage.$Properties | proto.Message.StickerMessage.$Properties;
export {};
//# sourceMappingURL=download.d.ts.map