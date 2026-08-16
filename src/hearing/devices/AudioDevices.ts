export type AudioDeviceInfo = {
  deviceId: string;
  label: string;
  kind: "audioinput" | "audiooutput";
  groupId: string;
};

export type AudioDeviceLists = {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
};

const BT_HINT =
  /bluetooth|airpods|buds|headset|hands-?free|hfp|sco|wh-?\d|galaxy buds|bose|sony|jabra|anker|soundcore|beats|pixel buds/i;

function mapDevice(device: MediaDeviceInfo): AudioDeviceInfo {
  return {
    deviceId: device.deviceId,
    label: device.label || fallbackLabel(device),
    kind: device.kind as "audioinput" | "audiooutput",
    groupId: device.groupId,
  };
}

function fallbackLabel(device: MediaDeviceInfo): string {
  if (device.kind === "audioinput") return `Microphone (${device.deviceId.slice(0, 6)})`;
  return `Speaker (${device.deviceId.slice(0, 6)})`;
}

/** Brief getUserMedia so enumerateDevices returns labeled IDs. */
export async function unlockAudioDeviceLabels(): Promise<void> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Media devices are only available in the browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  stream.getTracks().forEach((track) => track.stop());
}

export async function listAudioDevices(): Promise<AudioDeviceLists> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === "audioinput").map(mapDevice),
    outputs: devices.filter((d) => d.kind === "audiooutput").map(mapDevice),
  };
}

export function isBluetoothLabel(label: string): boolean {
  return BT_HINT.test(label);
}

/**
 * Pick a mic that will not force Bluetooth into HFP/SCO.
 *
 * Auto-selecting a BT mic (or the "communications" device) is what kicks
 * A2DP speakers offline — YouTube never opens a mic, so the speaker stays up.
 * Only use Bluetooth input when the user explicitly selects it.
 */
export function pickSafeInput(
  inputs: AudioDeviceInfo[],
  preferredId?: string,
): AudioDeviceInfo | undefined {
  if (preferredId) {
    const exact = inputs.find((d) => d.deviceId === preferredId);
    if (exact) return exact;
  }

  const builtIn = inputs.find(
    (d) =>
      d.deviceId !== "default" &&
      d.deviceId !== "communications" &&
      !isBluetoothLabel(d.label),
  );
  if (builtIn) return builtIn;

  return (
    inputs.find((d) => d.deviceId === "default") ??
    inputs.find((d) => !isBluetoothLabel(d.label)) ??
    inputs[0]
  );
}

/** @deprecated Use pickSafeInput — kept for callers that still import the old name. */
export function pickPreferredInput(
  inputs: AudioDeviceInfo[],
  preferredId?: string,
): AudioDeviceInfo | undefined {
  return pickSafeInput(inputs, preferredId);
}

/**
 * Output routing:
 * - User pick → that device (setSinkId)
 * - Mic is an explicit BT headset → same groupId speaker
 * - Otherwise → system default (undefined), same as YouTube / OS BT speaker
 */
export function pickMatchingOutput(
  outputs: AudioDeviceInfo[],
  input?: AudioDeviceInfo,
  preferredId?: string,
): AudioDeviceInfo | undefined {
  if (preferredId) {
    const exact = outputs.find((d) => d.deviceId === preferredId);
    if (exact) return exact;
  }

  if (input && isBluetoothLabel(input.label) && input.groupId) {
    const matched = outputs.find(
      (d) => d.groupId === input.groupId && d.deviceId.length > 0,
    );
    if (matched) return matched;
  }

  return undefined;
}

export function findInputById(
  inputs: AudioDeviceInfo[],
  deviceId: string | undefined,
): AudioDeviceInfo | undefined {
  if (!deviceId) return undefined;
  return inputs.find((d) => d.deviceId === deviceId);
}
