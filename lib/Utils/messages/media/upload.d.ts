import { Readable } from 'stream';
import { URL } from 'url';
import { type MediaType } from '../../../Defaults/index.js';
import type { MediaDecryptionKeyInfo, WAMediaUpload, WAMessageContent } from '../../../Types/index.js';
import type { ILogger } from '../../logger.js';
export declare const hkdfInfoKey: (type: MediaType) => string;
export declare const getRawMediaUploadData: (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => Promise<{
    filePath: string;
    fileSha256: NonSharedBuffer;
    fileLength: number;
}>;
/** generates all the keys required to encrypt/decrypt & sign a media message */
export declare function getMediaKeys(buffer: Uint8Array | string | null | undefined, mediaType: MediaType): Promise<MediaDecryptionKeyInfo>;
export declare const extractImageThumb: (bufferOrFilePath: Readable | Buffer | string, width?: number) => Promise<{
    buffer: Buffer<ArrayBufferLike>;
    original: {
        width: number;
        height: number;
    };
}>;
export declare const encodeBase64EncodedStringForUpload: (b64: string) => string;
export declare const generateProfilePicture: (mediaUpload: WAMediaUpload, dimensions?: {
    width: number;
    height: number;
}) => Promise<{
    img: Buffer<ArrayBufferLike>;
}>;
/** gets the SHA256 of the given media message */
export declare const mediaMessageSHA256B64: (message: WAMessageContent) => string | null | undefined;
export declare function getAudioDuration(buffer: Buffer | string | Readable): Promise<number | undefined>;
export declare const toReadable: (buffer: Buffer) => Readable;
export declare const toBuffer: (stream: Readable) => Promise<Buffer<ArrayBuffer>>;
export declare const getStream: (item: WAMediaUpload, opts?: RequestInit & {
    maxContentLength?: number;
}) => Promise<{
    readonly stream: Readable;
    readonly type: "buffer";
} | {
    readonly stream: Readable;
    readonly type: "readable";
} | {
    readonly stream: Readable;
    readonly type: "remote";
} | {
    readonly stream: import("fs").ReadStream;
    readonly type: "file";
}>;
export declare const getHttpStream: (url: string | URL, options?: RequestInit & {
    isStream?: true;
}) => Promise<Readable>;
type EncryptedStreamOptions = {
    saveOriginalFileIfRequired?: boolean;
    logger?: ILogger;
    opts?: RequestInit & {
        maxContentLength?: number;
    };
    mediaKey?: Buffer;
};
/** generates a thumbnail for a given media, if required */
export declare function generateThumbnail(file: string, mediaType: 'video' | 'image', options: {
    logger?: ILogger;
}): Promise<{
    thumbnail: string | undefined;
    originalImageDimensions: {
        width: number;
        height: number;
    } | undefined;
}>;
export declare const encryptedStream: (media: WAMediaUpload, mediaType: MediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedKey }?: EncryptedStreamOptions) => Promise<{
    mediaKey: Buffer<ArrayBufferLike>;
    originalFilePath: string | undefined;
    encFilePath: string;
    mac: Buffer<ArrayBuffer>;
    fileEncSha256: NonSharedBuffer;
    fileSha256: NonSharedBuffer;
    fileLength: number;
}>;
export {};
//# sourceMappingURL=upload.d.ts.map