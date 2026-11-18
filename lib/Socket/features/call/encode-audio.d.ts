import type { ILogger } from '../../../Utils/logger.js';
import type { CallState } from './calls.js';
import type { ResolvedCallFiles } from './media-file.js';
export interface EncodeAudioOptions {
    /** Destination folder. Created recursively if it does not exist. */
    dir: string;
    /** Output name without extension. Default: the input's base name. */
    fileName?: string;
    /** Re-encode even if the output already exists. Default: `true`. */
    overwrite?: boolean;
    /** ffmpeg binary. Default: `ffmpeg` from PATH. */
    ffmpegPath?: string;
    logger?: ILogger | undefined;
}
export interface EncodedAudio {
    /** Absolute path of the encoded file (`<name>.opus.raw`, raw Opus packets with no container). */
    path: string;
    packets: number;
    bytes: number;
    durationMs: number;
}
/**
 * Converts any audio ffmpeg can read (mp3, wav, m4a, ogg, a URL...) into the packet stream
 * that `CallMediaStream.playOpusFile()` plays directly, and saves it in `dir`.
 * The call then sends this file as-is, with no real-time conversion.
 */
export declare function encodeAudioForCall(input: string, options: EncodeAudioOptions): Promise<EncodedAudio>;
/** Reads a file made by `encodeAudioForCall`, ready for `media.playOpusFile(...)`. */
export declare function readEncodedAudio(path: string): Promise<Buffer>;
export declare function enableEncodedAudio(call: CallState, pending: WeakMap<CallState, ResolvedCallFiles>): CallState & {
    /** Schedules the file for playback on acceptance, or replaces the audio of a connected call. */
    streamEncodedAudio(file: EncodedAudio | string): Promise<void>;
};
//# sourceMappingURL=encode-audio.d.ts.map