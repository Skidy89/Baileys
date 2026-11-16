import { CallEngine, type VoipConfig } from '@skidy89/signal-protocol';
import { Duplex, type DuplexOptions } from 'node:stream';
import type { ILogger } from '../../../Utils/logger.js';
export type { VoipConfig, VoipOutput } from '@skidy89/signal-protocol';
export type CallMediaOptions = DuplexOptions & {
    /** Called for each H.264 Annex-B access unit received from the peer. */
    onVideo?: (frame: Buffer) => void;
    logger?: ILogger | undefined;
};
/**
 * RelayChannel transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export declare class CallMediaStream extends Duplex {
    #private;
    private logger?;
    constructor(config: VoipConfig | {
        engine: CallEngine;
        relayIp: string;
        relayPort: number;
    }, options?: CallMediaOptions, logger?: ILogger | undefined);
    get elapsedMs(): number;
    get connected(): boolean;
    _read(): void;
    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
    _final(callback: (error?: Error | null) => void): void;
    /** Queue PCM frames directly for the 60 ms microphone tick, bypassing Writable buffering. */
    speak(pcm: Int16Array, replace?: boolean): void;
    /** Send one H.264 Annex-B access unit; call `enableVideo()` first. */
    writeVideoFrame(frame: Uint8Array): void;
    startVideoFrames(frames: Uint8Array[], fps?: number, gated?: boolean): boolean;
    releaseVideo(): void;
    stopVideo(): void;
    pauseMedia(): void;
    resumeMedia(): void;
    clearAudio(): void;
    setVolume(gain: number): void;
    get volume(): number;
    get paused(): boolean;
    get queuedSeconds(): number;
    enableVideo(gated?: boolean): boolean;
    rekeyRecv(peerLid: string): boolean;
    disableVideo(): void;
    get stats(): string;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
}
export declare const createCallMediaStream: (config: VoipConfig, options?: CallMediaOptions) => CallMediaStream;
export declare const createCallMediaStreamFromEngine: (engine: CallEngine, relayIp: string, relayPort: number, options?: CallMediaOptions) => CallMediaStream;
//# sourceMappingURL=call-media.d.ts.map