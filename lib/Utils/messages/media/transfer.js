import { Boom } from '@hapi/boom';
import * as Crypto from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { pipeline, Readable, Transform } from 'stream';
import { URL } from 'url';
import { DEFAULT_ORIGIN, MEDIA_PATH_MAP } from '../../../Defaults/index.js';
import { toBufferView, toError } from '../../generics.js';
import { encodeBase64EncodedStringForUpload, getHttpStream, getMediaKeys } from './upload.js';
export const DEF_MEDIA_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
const MEDIA_UPLOAD_READ_SIZE = 256 * 1024;
const toSmallestChunkSize = (num) => {
    return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
};
export const getUrlFromDirectPath = (directPath, host = DEF_MEDIA_HOST) => `https://${host}${directPath}`;
const extractHost = (url) => {
    if (!url)
        return undefined;
    try {
        return new URL(url).host;
    }
    catch {
        return undefined;
    }
};
const isAllowedMediaUrl = (url, directPath, host) => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' ||
            (parsed.port !== '' && parsed.port !== '443') ||
            (parsed.hostname !== 'whatsapp.net' && !parsed.hostname.endsWith('.whatsapp.net'))) {
            return false;
        }
        return !directPath || parsed.hostname === new URL(`https://${host}`).hostname;
    }
    catch {
        return false;
    }
};
export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    // Fallback host: explicit opt > host parsed from `url` > DEF_MEDIA_HOST.
    // Lets us honor a non-default host carried by the proto without forcing callers to thread it through.
    const fallbackHost = opts.host ?? extractHost(url) ?? DEF_MEDIA_HOST;
    const downloadUrl = directPath ? getUrlFromDirectPath(directPath, fallbackHost) : url;
    if (!downloadUrl || !isAllowedMediaUrl(downloadUrl, directPath, fallbackHost)) {
        throw new Boom('No valid WhatsApp media URL or directPath present in message', { statusCode: 400 });
    }
    const keys = await getMediaKeys(mediaKey, type);
    return downloadEncryptedContent(downloadUrl, keys, opts);
};
/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options, expectedFileEncSha256 } = {}) => {
    if (expectedFileEncSha256 && expectedFileEncSha256.byteLength !== 32) {
        throw new Boom('Expected media ciphertext SHA-256 must be 32 bytes', { statusCode: 400 });
    }
    if (expectedFileEncSha256 && (startByte || endByte)) {
        throw new Boom('Cannot verify a full-file SHA-256 for a ranged media download', { statusCode: 400 });
    }
    let bytesFetched = 0;
    let startChunk = 0;
    let firstBlockIsIV = false;
    // if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0);
        if (chunk) {
            startChunk = chunk - AES_CHUNK_SIZE;
            bytesFetched = chunk;
            firstBlockIsIV = true;
        }
    }
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
    const headersInit = options?.headers ? options.headers : undefined;
    const headers = {
        ...(headersInit
            ? Array.isArray(headersInit)
                ? Object.fromEntries(headersInit)
                : headersInit
            : {}),
        Origin: DEFAULT_ORIGIN
    };
    if (startChunk || endChunk) {
        headers.Range = `bytes=${startChunk}-`;
        if (endChunk) {
            headers.Range += endChunk;
        }
    }
    // download the message
    const fetched = await getHttpStream(downloadUrl, {
        ...(options || {}),
        headers,
        // Prevent fetch from following a WhatsApp CDN redirect to an untrusted host.
        redirect: 'error'
    });
    const remainingBytes = Buffer.allocUnsafe(AES_CHUNK_SIZE);
    let remainingLength = 0;
    const encryptedHash = expectedFileEncSha256 ? Crypto.createHash('sha256') : undefined;
    let aes;
    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
            push(bytes.slice(start, end));
            bytesFetched += bytes.length;
        }
        else {
            push(bytes);
        }
    };
    const output = new Transform({
        transform(chunk, _, callback) {
            try {
                const data = Buffer.isBuffer(chunk) ? chunk : toBufferView(chunk);
                encryptedHash?.update(data);
                let offset = 0;
                const decrypt = (bytes) => {
                    if (!aes) {
                        let ivValue = iv;
                        if (firstBlockIsIV) {
                            ivValue = bytes.subarray(0, AES_CHUNK_SIZE);
                            bytes = bytes.subarray(AES_CHUNK_SIZE);
                        }
                        aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
                        // if an end byte that is not EOF is specified
                        // stop auto padding (PKCS7) -- otherwise throws an error for decryption
                        if (endByte) {
                            aes.setAutoPadding(false);
                        }
                    }
                    if (bytes.length)
                        pushBytes(aes.update(bytes), b => this.push(b));
                };
                if (remainingLength) {
                    const needed = AES_CHUNK_SIZE - remainingLength;
                    if (data.length < needed) {
                        remainingLength += data.copy(remainingBytes, remainingLength);
                        callback();
                        return;
                    }
                    data.copy(remainingBytes, remainingLength, 0, needed);
                    remainingLength = 0;
                    decrypt(remainingBytes);
                    offset = needed;
                }
                const decryptLength = toSmallestChunkSize(data.length - offset);
                const end = offset + decryptLength;
                if (decryptLength)
                    decrypt(data.subarray(offset, end));
                if (end < data.length)
                    remainingLength = data.copy(remainingBytes, 0, end);
                callback();
            }
            catch (error) {
                callback(toError(error));
            }
        },
        final(callback) {
            try {
                if (encryptedHash) {
                    const actualHash = encryptedHash.digest();
                    const expectedHash = Buffer.from(expectedFileEncSha256);
                    if (expectedHash.length !== actualHash.length || !Crypto.timingSafeEqual(actualHash, expectedHash)) {
                        callback(new Error('media ciphertext SHA-256 mismatch'));
                        return;
                    }
                }
                pushBytes(aes.final(), b => this.push(b));
                callback();
            }
            catch (error) {
                callback(toError(error));
            }
        }
    });
    fetched.once('error', error => output.destroy(error));
    output.once('close', () => fetched.destroy());
    pipeline(fetched, output, () => { });
    return output;
};
export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype.split(';')[0]?.split('/')[1];
    const type = Object.keys(message)[0];
    let extension;
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
        extension = '.jpeg';
    }
    else {
        const messageContent = message[type];
        extension = getExtension(messageContent.mimetype);
    }
    return extension;
}
const isNodeRuntime = () => {
    return (typeof process !== 'undefined' &&
        process.versions?.node !== null &&
        typeof process.versions.bun === 'undefined' &&
        typeof globalThis.Deno === 'undefined');
};
export const uploadWithNodeHttp = async ({ url, filePath, headers, timeoutMs, agent }, redirectCount = 0) => {
    if (redirectCount > 5) {
        throw new Error('Too many redirects');
    }
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? await import('https') : await import('http');
    // Get file size for Content-Length header (required for Node.js streaming)
    const fileStats = await fs.stat(filePath);
    const fileSize = fileStats.size;
    return new Promise((resolve, reject) => {
        const req = httpModule.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': fileSize
            },
            agent,
            timeout: timeoutMs
        }, res => {
            // Handle redirects (3xx)
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume(); // Consume response to free resources
                const newUrl = new URL(res.headers.location, url).toString();
                resolve(uploadWithNodeHttp({
                    url: newUrl,
                    filePath,
                    headers,
                    timeoutMs,
                    agent
                }, redirectCount + 1));
                return;
            }
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        resolve(undefined);
                        return;
                    }
                    const result = parsed;
                    resolve({
                        ...(typeof result.url === 'string' ? { url: result.url } : {}),
                        ...(typeof result.direct_path === 'string' ? { direct_path: result.direct_path } : {}),
                        ...(typeof result.meta_hmac === 'string' ? { meta_hmac: result.meta_hmac } : {}),
                        ...(typeof result.ts === 'number' ? { ts: result.ts } : {}),
                        ...(typeof result.fbid === 'number' ? { fbid: result.fbid } : {})
                    });
                }
                catch {
                    resolve(undefined);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Upload timeout'));
        });
        const stream = createReadStream(filePath, { highWaterMark: MEDIA_UPLOAD_READ_SIZE });
        stream.pipe(req);
        stream.on('error', err => {
            req.destroy();
            reject(err);
        });
    });
};
const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }) => {
    // Convert Node.js Readable to Web ReadableStream
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);
    // Native fetch only accepts Undici-style dispatchers, not generic https Agents.
    const dispatcher = typeof agent?.dispatch === 'function' ? agent : undefined;
    const response = await fetch(url, {
        ...(dispatcher ? { dispatcher } : {}),
        method: 'POST',
        body: webStream,
        headers,
        duplex: 'half',
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
    try {
        return (await response.json());
    }
    catch {
        return undefined;
    }
};
/**
 * Uploads media to WhatsApp servers.
 *
 * ## Why we have two upload implementations:
 *
 * Node.js's native `fetch` (powered by undici) has a known bug where it buffers
 * the entire request body in memory before sending, even when using streams.
 * This causes memory issues with large files (e.g., 1GB file = 1GB+ memory usage).
 * See: https://github.com/nodejs/undici/issues/4058
 *
 * Other runtimes (Bun, Deno, browsers) correctly stream the request body without
 * buffering, so we can use the web-standard Fetch API there.
 *
 * ## Future considerations:
 * Once the undici bug is fixed, we can simplify this to use only the Fetch API
 * across all runtimes. Monitor the GitHub issue for updates.
 */
const uploadMedia = async (params, logger) => {
    if (isNodeRuntime()) {
        logger?.debug('Using Node.js https module for upload (avoids undici buffering bug)');
        return uploadWithNodeHttp(params);
    }
    else {
        logger?.debug('Using web-standard Fetch API for upload');
        return uploadWithFetch(params);
    }
};
export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
        // send a query JSON to obtain the url & auth token to upload our media
        let uploadInfo = await refreshMediaConn(false);
        let urls;
        const hosts = [...customUploadHosts, ...uploadInfo.hosts];
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
        // Prepare common headers
        const customHeaders = (() => {
            const hdrs = options?.headers;
            if (!hdrs)
                return {};
            return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : hdrs;
        })();
        const headers = {
            ...customHeaders,
            'Content-Type': 'application/octet-stream',
            Origin: DEFAULT_ORIGIN
        };
        for (const { hostname } of hosts) {
            if (logger)
                logger.debug(`uploading to "${hostname}"`);
            const auth = encodeURIComponent(uploadInfo.auth);
            const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
            let result;
            try {
                result = await uploadMedia({
                    url,
                    filePath,
                    headers,
                    timeoutMs,
                    agent: fetchAgent
                }, logger);
                if (result?.url || result?.direct_path) {
                    urls = {
                        mediaUrl: result.url,
                        directPath: result.direct_path,
                        meta_hmac: result.meta_hmac,
                        fbid: result.fbid,
                        ts: result.ts
                    };
                    break;
                }
                else {
                    uploadInfo = await refreshMediaConn(true);
                    throw new Error(`upload failed, reason: ${JSON.stringify(result)}`);
                }
            }
            catch (error) {
                const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname;
                if (logger)
                    logger.warn({ trace: toError(error).stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`);
            }
        }
        if (!urls) {
            throw new Boom('Media upload failed on all hosts', { statusCode: 500 });
        }
        return urls;
    };
};
//# sourceMappingURL=transfer.js.map