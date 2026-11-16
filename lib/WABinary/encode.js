import * as constants from './constants.js';
import { jidDecode } from './jid-utils.js';
// shortcut: threshold is tuned for Node's buffer encoder; rebenchmark for other runtimes.
const DIRECT_STRING_WRITE_MIN_LENGTH = 24;
const packNibble = (char) => {
    switch (char) {
        case 45:
            return 10;
        case 46:
            return 11;
        case 0:
            return 15;
        default:
            if (char >= 48 && char <= 57)
                return char - 48;
            throw new Error(`invalid byte for nibble "${String.fromCharCode(char)}"`);
    }
};
const packHex = (char) => {
    if (char >= 48 && char <= 57)
        return char - 48;
    if (char >= 65 && char <= 70)
        return char - 55;
    if (char >= 97 && char <= 102)
        return char - 87;
    if (char === 0)
        return 15;
    throw new Error(`Invalid hex char "${String.fromCharCode(char)}"`);
};
const getPackedStringType = (str, maxLength) => {
    if (!str || str.length > maxLength)
        return undefined;
    let nibble = true;
    let hex = true;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        if (char >= 48 && char <= 57)
            continue;
        if (char === 45 || char === 46) {
            hex = false;
            continue;
        }
        nibble = false;
        if (char < 65 || char > 70)
            hex = false;
        if (!nibble && !hex)
            return undefined;
    }
    return nibble ? 'nibble' : hex ? 'hex' : undefined;
};
class BinaryNodeBuffer {
    constructor() {
        this.buffer = Buffer.allocUnsafe(128);
        this.length = 0;
    }
    writeByte(value) {
        this.ensureCapacity(1);
        this.buffer[this.length++] = value & 0xff;
    }
    writeBytes(bytes) {
        this.ensureCapacity(bytes.length);
        if (Array.isArray(bytes)) {
            for (const byte of bytes)
                this.buffer[this.length++] = byte;
        }
        else {
            this.buffer.set(bytes, this.length);
            this.length += bytes.length;
        }
    }
    writeString(value, byteLength) {
        this.ensureCapacity(byteLength);
        this.length += this.buffer.write(value, this.length, byteLength, 'utf-8');
    }
    toBuffer() {
        const view = this.buffer.subarray(0, this.length);
        return this.buffer.length - this.length < this.length ? view : Buffer.from(view);
    }
    ensureCapacity(additional) {
        const required = this.length + additional;
        if (required <= this.buffer.length)
            return;
        const capacity = Math.max(this.buffer.length * 2, required);
        const buffer = Buffer.allocUnsafe(capacity);
        this.buffer.copy(buffer, 0, 0, this.length);
        this.buffer = buffer;
    }
}
export const encodeBinaryNode = (node, opts = constants, buffer = undefined) => {
    const output = buffer ?? new BinaryNodeBuffer();
    if (output instanceof BinaryNodeBuffer)
        output.writeByte(0);
    encodeBinaryNodeInner(node, opts, output);
    return output instanceof BinaryNodeBuffer ? output.toBuffer() : Buffer.from(output);
};
const encodeBinaryNodeInner = ({ tag, attrs, content }, opts, buffer) => {
    const { TAGS, TOKEN_MAP } = opts;
    const pushByte = (value) => {
        if (buffer instanceof BinaryNodeBuffer)
            buffer.writeByte(value);
        else
            buffer.push(value & 0xff);
    };
    const pushInt = (value, n, littleEndian = false) => {
        for (let i = 0; i < n; i++) {
            const curShift = littleEndian ? i : n - 1 - i;
            pushByte((value >> (curShift * 8)) & 0xff);
        }
    };
    const pushBytes = (bytes) => {
        if (buffer instanceof BinaryNodeBuffer) {
            buffer.writeBytes(bytes);
            return;
        }
        for (const b of bytes) {
            buffer.push(b);
        }
    };
    const pushInt16 = (value) => {
        pushBytes([(value >> 8) & 0xff, value & 0xff]);
    };
    const pushInt20 = (value) => pushBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff]);
    const writeByteLength = (length) => {
        if (length >= 4294967296) {
            throw new Error('string too large to encode: ' + length);
        }
        if (length >= 1 << 20) {
            pushByte(TAGS.BINARY_32);
            pushInt(length, 4); // 32 bit integer
        }
        else if (length >= 256) {
            pushByte(TAGS.BINARY_20);
            pushInt20(length);
        }
        else {
            pushByte(TAGS.BINARY_8);
            pushByte(length);
        }
    };
    const writeStringRaw = (str) => {
        if (buffer instanceof BinaryNodeBuffer && str.length >= DIRECT_STRING_WRITE_MIN_LENGTH) {
            const byteLength = Buffer.byteLength(str, 'utf-8');
            writeByteLength(byteLength);
            buffer.writeString(str, byteLength);
            return;
        }
        const bytes = Buffer.from(str, 'utf-8');
        writeByteLength(bytes.length);
        pushBytes(bytes);
    };
    const writeJid = ({ domainType, device, user, server }) => {
        if (typeof device !== 'undefined') {
            pushByte(TAGS.AD_JID);
            pushByte(domainType || 0);
            pushByte(device || 0);
            writeString(user);
        }
        else {
            pushByte(TAGS.JID_PAIR);
            if (user.length) {
                writeString(user);
            }
            else {
                pushByte(TAGS.LIST_EMPTY);
            }
            writeString(server);
        }
    };
    const writePackedBytes = (str, type) => {
        if (str.length > TAGS.PACKED_MAX) {
            throw new Error('Too many bytes to pack');
        }
        pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8);
        let roundedLength = Math.ceil(str.length / 2.0);
        if (str.length % 2 !== 0) {
            roundedLength |= 128;
        }
        pushByte(roundedLength);
        const packFunction = type === 'nibble' ? packNibble : packHex;
        const strLengthHalf = Math.floor(str.length / 2);
        for (let i = 0; i < strLengthHalf; i++) {
            pushByte((packFunction(str.charCodeAt(2 * i)) << 4) | packFunction(str.charCodeAt(2 * i + 1)));
        }
        if (str.length % 2 !== 0) {
            pushByte((packFunction(str.charCodeAt(str.length - 1)) << 4) | packFunction(0));
        }
    };
    const writeString = (str) => {
        if (str === undefined || str === null) {
            pushByte(TAGS.LIST_EMPTY);
            return;
        }
        if (str === '') {
            writeStringRaw(str);
            return;
        }
        const tokenIndex = TOKEN_MAP[str];
        if (tokenIndex) {
            if (typeof tokenIndex.dict === 'number') {
                pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict);
            }
            pushByte(tokenIndex.index);
        }
        else {
            const packedType = getPackedStringType(str, TAGS.PACKED_MAX);
            if (packedType) {
                writePackedBytes(str, packedType);
            }
            else {
                const decodedJid = jidDecode(str);
                if (decodedJid) {
                    writeJid(decodedJid);
                }
                else {
                    writeStringRaw(str);
                }
            }
        }
    };
    const writeListStart = (listSize) => {
        if (listSize === 0) {
            pushByte(TAGS.LIST_EMPTY);
        }
        else if (listSize < 256) {
            pushBytes([TAGS.LIST_8, listSize]);
        }
        else {
            pushByte(TAGS.LIST_16);
            pushInt16(listSize);
        }
    };
    if (!tag) {
        throw new Error('Invalid node: tag cannot be undefined');
    }
    const validAttributes = Object.keys(attrs || {});
    let validAttributeCount = 0;
    for (const key of validAttributes) {
        if (attrs[key] !== undefined && attrs[key] !== null)
            validAttributeCount++;
    }
    writeListStart(2 * validAttributeCount + 1 + (typeof content !== 'undefined' ? 1 : 0));
    writeString(tag);
    for (const key of validAttributes) {
        if (typeof attrs[key] === 'string') {
            writeString(key);
            writeString(attrs[key]);
        }
    }
    if (typeof content === 'string') {
        writeString(content);
    }
    else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
        writeByteLength(content.length);
        pushBytes(content);
    }
    else if (Array.isArray(content)) {
        let validContentCount = 0;
        for (const item of content) {
            if (item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')) {
                validContentCount++;
            }
        }
        writeListStart(validContentCount);
        for (const item of content) {
            if (!item || !(item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string'))
                continue;
            encodeBinaryNodeInner(item, opts, buffer);
        }
    }
    else if (typeof content === 'undefined') {
        // do nothing
    }
    else {
        throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`);
    }
};
//# sourceMappingURL=encode.js.map