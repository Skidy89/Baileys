import assert from "assert";
import { calculateMAC } from "libsignal/src/crypto";

function assertBuffer(input: Buffer): void {
  if (!Buffer.isBuffer(input)) {
	throw new Error("Expected Buffer");
  }
}
function deriveSecrets(input: any, salt: any, info: any, chunks?: number): Uint8Array[] {
  // Specific implementation of RFC 5869 that only returns the first 3 32-byte chunks
  assertBuffer(input);
  assertBuffer(salt);
  assertBuffer(info);
  if (salt.byteLength != 32) {
    throw new Error("Got salt of incorrect length");
  }
  chunks = chunks || 3;
  assert(chunks >= 1 && chunks <= 3);
  const PRK: any = calculateMAC(salt, input);
  const infoArray = new Uint8Array(info.byteLength + 1 + 32);
  infoArray.set(info, 32);
  infoArray[infoArray.length - 1] = 1;
  const signed: any[] = [calculateMAC(PRK, Buffer.from(infoArray.slice(32)))];
  if (chunks > 1) {
    infoArray.set(signed[signed.length - 1]);
    infoArray[infoArray.length - 1] = 2;
    signed.push(calculateMAC(PRK, Buffer.from(infoArray)));
  }
  if (chunks > 2) {
    infoArray.set(signed[signed.length - 1]);
    infoArray[infoArray.length - 1] = 3;
    signed.push(calculateMAC(PRK, Buffer.from(infoArray)));
  }
  return signed;
}
export class SenderMessageKey {
	private readonly iteration: number
	private readonly iv: Uint8Array
	private readonly cipherKey: Uint8Array
	private readonly seed: Uint8Array

	constructor(iteration: number, seed: Uint8Array) {
		const derivative: any[] = deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'))
		const keys = new Uint8Array(32)
		keys.set(new Uint8Array(derivative[0].subarray(16)))
		keys.set(new Uint8Array(derivative[1].subarray(0, 16)), 16)

		this.iv = Buffer.from(derivative[0].subarray(0, 16))
		this.cipherKey = Buffer.from(keys.buffer)
		this.iteration = iteration
		this.seed = seed
	}

	public getIteration(): number {
		return this.iteration
	}

	public getIv(): Uint8Array {
		return this.iv
	}

	public getCipherKey(): Uint8Array {
		return this.cipherKey
	}

	public getSeed(): Uint8Array {
		return this.seed
	}
}
