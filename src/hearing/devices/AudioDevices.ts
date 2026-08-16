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

type MediaDevicesWithOutputPicker = MediaDevices & {
  selectAudioOutput?: (options?: {
    deviceId?: string;
  }) => Promise<MediaDeviceInfo>;
};

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

/** Brief getUserMedia so enumerateDevices returns labeled input IDs. */
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

/**
 * Android/Chrome: mic permission alone does NOT expose audiooutput devices.
 * Speakers (incl. Bluetooth) only appear after selectAudioOutput() grants them.
 */
export function canSelectAudioOutput(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return false;
  const media = navigator.mediaDevices as MediaDevicesWithOutputPicker;
  return typeof media.selectAudioOutput === "function";
}

/**
 * Opens the OS speaker picker (needed on Android to reveal Bluetooth outputs).
 * Must run from a user gesture (button tap).
 */
export async function pickAudioOutputDevice(): Promise<AudioDeviceInfo | null> {
  if (!canSelectAudioOutput()) return null;
  const media = navigator.mediaDevices as MediaDevicesWithOutputPicker;
  try {
    const device = await media.selectAudioOutput!();
    return mapDevice(device);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return null;
    }
    throw error;
  }
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
 * Default mic: Bluetooth if connected, else built-in.
 * Explicit preferredId always wins when still present.
 */
export function pickAutoInput(
  inputs: AudioDeviceInfo[],
  preferredId?: string,
): AudioDeviceInfo | undefined {
  if (preferredId) {
    const exact = inputs.find((d) => d.deviceId === preferredId);
    if (exact) return exact;
  }

  const bluetooth = inputs.find(
    (d) =>
      isBluetoothLabel(d.label) &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications",
  );
  if (bluetooth) return bluetooth;

  // Some OSes expose the active BT headset only as "communications".
  const communications = inputs.find((d) => d.deviceId === "communications");
  if (communications && isBluetoothLabel(communications.label)) {
    return communications;
  }

  return (
    inputs.find(
      (d) =>
        d.deviceId !== "default" &&
        d.deviceId !== "communications" &&
        !isBluetoothLabel(d.label),
    ) ??
    inputs.find((d) => d.deviceId === "default") ??
    inputs[0]
  );
}

/** @deprecated Use pickAutoInput */
export function pickSafeInput(
  inputs: AudioDeviceInfo[],
  preferredId?: string,
): AudioDeviceInfo | undefined {
  return pickAutoInput(inputs, preferredId);
}

/** @deprecated Use pickAutoInput */
export function pickPreferredInput(
  inputs: AudioDeviceInfo[],
  preferredId?: string,
): AudioDeviceInfo | undefined {
  return pickAutoInput(inputs, preferredId);
}

/**
 * Default speaker: same Bluetooth headset as mic (groupId), else any BT
 * output, else user pick, else system default (undefined).
 */
export function pickAutoOutput(
  outputs: AudioDeviceInfo[],
  input?: AudioDeviceInfo,
  preferredId?: string,
): AudioDeviceInfo | undefined {
  if (preferredId) {
    const exact = outputs.find((d) => d.deviceId === preferredId);
    if (exact) return exact;
  }

  if (input?.groupId) {
    const matched = outputs.find(
      (d) => d.groupId === input.groupId && d.deviceId.length > 0,
    );
    if (matched) return matched;
  }

  const bluetooth = outputs.find(
    (d) =>
      isBluetoothLabel(d.label) &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications",
  );
  if (bluetooth) return bluetooth;

  return undefined;
}

/** @deprecated Use pickAutoOutput */
export function pickMatchingOutput(
  outputs: AudioDeviceInfo[],
  input?: AudioDeviceInfo,
  preferredId?: string,
): AudioDeviceInfo | undefined {
  return pickAutoOutput(outputs, input, preferredId);
}

export function findInputById(
  inputs: AudioDeviceInfo[],
  deviceId: string | undefined,
): AudioDeviceInfo | undefined {
  if (!deviceId) return undefined;
  return inputs.find((d) => d.deviceId === deviceId);
}
