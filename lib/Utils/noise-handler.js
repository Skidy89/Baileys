import { Boom } from '@hapi/boom';
import { FrameDecoder, encodeFrame as encodeNativeFrame } from '@skidy89/signal-protocol';
import { proto } from '../../WAProto/index.js';
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto.js';
const generateIV = (counter) => {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(counter, 8);
    return iv;
};
export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    const authenticate = (data) => {
        if (!isFinished) {
            hash = sha256(Buffer.concat([hash, data]));
        }
    };
    const encrypt = (plaintext) => {
        const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash);
        writeCounter += 1;
        authenticate(result);
        return result;
    };
    const decrypt = (ciphertext) => {
        // before the handshake is finished, we use the same counter
        // after handshake, the counters are different
        const iv = generateIV(isFinished ? readCounter : writeCounter);
        const result = aesDecryptGCM(ciphertext, decKey, iv, hash);
        if (isFinished) {
            readCounter += 1;
        }
        else {
            writeCounter += 1;
        }
        authenticate(ciphertext);
        return result;
    };
    const localHKDF = async (data) => {
        const key = await hkdf(Buffer.from(data), 64, { salt, info: '' });
        return [key.slice(0, 32), key.slice(32)];
    };
    const mixIntoKey = async (data) => {
        const [write, read] = await localHKDF(data);
        salt = write;
        encKey = read;
        decKey = read;
        readCounter = 0;
        writeCounter = 0;
    };
    const finishInit = async () => {
        const [write, read] = await localHKDF(new Uint8Array(0));
        encKey = write;
        decKey = read;
        hash = Buffer.from([]);
        readCounter = 0;
        writeCounter = 0;
        isFinished = true;
    };
    const data = Buffer.from(NOISE_MODE);
    let hash = data.byteLength === 32 ? data : sha256(data);
    let salt = hash;
    let encKey = hash;
    let decKey = hash;
    let readCounter = 0;
    let writeCounter = 0;
    let isFinished = false;
    let sentIntro = false;
    const frameDecoder = new FrameDecoder();
    authenticate(NOISE_HEADER);
    authenticate(publicKey);
    return {
        encrypt,
        decrypt,
        authenticate,
        mixIntoKey,
        finishInit,
        processHandshake: async ({ serverHello }, noiseKey) => {
            authenticate(serverHello.ephemeral);
            await mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));
            const decStaticContent = decrypt(serverHello.static);
            await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));
            const certDecoded = decrypt(serverHello.payload);
            const { intermediate: certIntermediate /*leaf*/ } = proto.CertChain.decode(certDecoded);
            // TODO: handle this leaf stuff
            const { issuerSerial } = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details);
            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                throw new Boom('certification match failed', { statusCode: 400 });
            }
            const keyEnc = encrypt(noiseKey.public);
            await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
            return keyEnc;
        },
        encodeFrame: (data) => {
            if (isFinished) {
                data = encrypt(data);
            }
            let header;
            if (routingInfo) {
                header = Buffer.alloc(7);
                header.write('ED', 0, 'utf8');
                header.writeUint8(0, 2);
                header.writeUint8(1, 3);
                header.writeUint8(routingInfo.byteLength >> 16, 4);
                header.writeUint16BE(routingInfo.byteLength & 65535, 5);
                header = Buffer.concat([header, routingInfo, NOISE_HEADER]);
            }
            else {
                header = Buffer.from(NOISE_HEADER);
            }
            const frame = encodeNativeFrame(Buffer.from(data), sentIntro ? undefined : header);
            sentIntro = true;
            return frame;
        },
        decodeFrame: async (newData, onFrame) => {
            if (logger) {
                logger.trace(`recv ${newData.length} bytes`);
            }
            frameDecoder.feed(Buffer.from(newData));
            let frame;
            while ((frame = frameDecoder.nextFrame())) {
                let decodedFrame = frame;
                if (isFinished) {
                    const result = decrypt(frame);
                    decodedFrame = await decodeBinaryNode(result);
                }
                if (logger)
                    logger.trace({ msg: decodedFrame?.attrs?.id }, 'recv frame');
                onFrame(decodedFrame);
            }
        }
    };
};
//# sourceMappingURL=noise-handler.js.map