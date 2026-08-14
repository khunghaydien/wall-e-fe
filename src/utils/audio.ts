export function float32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

export function int16ToFloat32(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    output[i] = (input[i] ?? 0) / 0x8000;
  }

  return output;
}

/** Linear resample — enough for speech uplink to a fixed transport rate. */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || fromRate === toRate) {
    return input;
  }
  if (input.length === 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIndex - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i1] ?? 0;
    output[i] = s0 + (s1 - s0) * t;
  }

  return output;
}
