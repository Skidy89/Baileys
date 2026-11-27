import type { Agent } from 'https';
import { Transform } from 'stream';
import { type MediaType } from '../../../Defaults/index.js';
import type { DownloadableMessage, MediaConnInfo, MediaDecryptionKeyInfo, SocketConfig, WAMediaUploadFunction, WAMessageContent } from '../../../Types/index.js';
export declare const DEF_MEDIA_HOST = "mmg.whatsapp.net";
export type MediaDownloadOptions = {
    startByte?: number;
    endByte?: number;
    options?: RequestInit;
    expectedFileEncSha256?: Uint8Array;
    /** Optional WhatsApp media CDN host override; must be on whatsapp.net. */
    host?: string;
};
export declare const getUrlFromDirectPath: (directPath: string, host?: string) => string;
export declare const downloadContentFromMessage: ({ mediaKey, directPath, url }: DownloadableMessage, type: MediaType, opts?: MediaDownloadOptions) => Promise<Transform>;
/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export declare const downloadEncryptedContent: (downloadUrl: string, { cipherKey, iv }: MediaDecryptionKeyInfo, { startByte, endByte, options, expectedFileEncSha256 }?: MediaDownloadOptions) => Promise<Transform>;
export declare function extensionForMediaMessage(message: WAMessageContent): string;
type MediaUploadResult = {
    url?: string;
    direct_path?: string;
    meta_hmac?: string;
    ts?: number;
    fbid?: number;
};
export type UploadParams = {
    url: string;
    filePath: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    agent?: Agent;
};
export declare const uploadWithNodeHttp: ({ url, filePath, headers, timeoutMs, agent }: UploadParams, redirectCount?: number) => Promise<MediaUploadResult | undefined>;
export declare const getWAUploadToServer: ({ customUploadHosts, fetchAgent, logger, options }: SocketConfig, refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>) => WAMediaUploadFunction;
export {};
//# sourceMappingURL=transfer.d.ts.map