/**
 * Operating mode of an input channel (MULTI_MODE_INPUT_TRANSMITTER, e.g.
 * HmIP-DSD-PCB, HmIP-FCI1/FCI6, wall-button inputs of HmIP-DRSI4):
 * MASTER parameter CHANNEL_OPERATION_MODE, set in the CCU. It decides what
 * the channel sends: key presses (PRESS_SHORT / PRESS_LONG) in key mode,
 * STATE in switch and binary mode, nothing when inactive.
 */
export const INPUT_CHANNEL_TYPE = 'MULTI_MODE_INPUT_TRANSMITTER';

export const INPUT_MODES = [
  'INACTIVE',
  'KEY_BEHAVIOR',
  'SWITCH_BEHAVIOR',
  'BINARY_BEHAVIOR',
] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/** Short names for log lines and the UI. */
export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  INACTIVE: 'inactive',
  KEY_BEHAVIOR: 'key',
  SWITCH_BEHAVIOR: 'switch',
  BINARY_BEHAVIOR: 'binary sensor',
};

/**
 * The CCU reports the ENUM as its index; every input channel in the
 * device data has this value list (some without BINARY_BEHAVIOR), so the
 * index maps the same way. Names are accepted as well.
 */
export function toInputMode(raw: unknown): InputMode | undefined {
  if (typeof raw === 'string' && (INPUT_MODES as readonly string[]).includes(raw)) {
    return raw as InputMode;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n < INPUT_MODES.length ? INPUT_MODES[n] : undefined;
}

/** Datapoints the channel sends in this mode. */
export function sendsKeyPresses(mode: InputMode): boolean {
  return mode === 'KEY_BEHAVIOR';
}
export function sendsState(mode: InputMode): boolean {
  return mode === 'SWITCH_BEHAVIOR' || mode === 'BINARY_BEHAVIOR';
}
