// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
/**
 * Defensive value coercion helpers used at every CCU → HomeKit boundary.
 *
 * The CCU returns datapoint values as either typed XML-RPC primitives or,
 * in some firmware revisions, as strings — and occasionally as `NaN`,
 * `Infinity`, or out-of-range numbers. HomeKit reacts badly to invalid
 * `updateCharacteristic` values: an accessory will simply stop responding
 * in the Home app until Homebridge restarts.
 *
 * `normalizeLevelToPercent` in particular guards against a CCU quirk
 * documented by AlexanderSchmutz/homebridge-homematic-asaw (ISC): some
 * Raspberrymatic builds emit `LEVEL` as 0..1 (the documented range),
 * others as 0..100. The naïve `value * 100` produces 10000 % blind
 * positions on the latter, which Homebridge then rejects and HomeKit
 * shows as "Not Responding". We auto-detect the range instead.
 */

/** Coerce arbitrary input to a finite number, or undefined. */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      return undefined;
    }
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return undefined;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Coerce to a finite, clamped number with a fallback if the input is
 * unusable. Use on every event path that drives `updateCharacteristic`.
 */
export function toRanged(value: unknown, min: number, max: number, fallback: number): number {
  const n = toFiniteNumber(value);
  if (n === undefined) {
    return fallback;
  }
  return clamp(n, min, max);
}

/**
 * Normalize a CCU LEVEL datapoint to a HomeKit percentage in [0, 100].
 *
 *   |value| ≤ 1   ⇒ assume native 0..1, multiply by 100
 *   |value| ≤ 100 ⇒ already a percentage
 *   otherwise     ⇒ clamp into range
 *
 * Returns undefined when the input cannot be made into a finite number.
 *
 * Adapted from AlexanderSchmutz/homebridge-homematic-asaw (ISC).
 */
export function normalizeLevelToPercent(value: unknown): number | undefined {
  const n = toFiniteNumber(value);
  if (n === undefined) {
    return undefined;
  }
  if (n >= -1 && n <= 1) {
    return clamp(Math.round(n * 100), 0, 100);
  }
  return clamp(Math.round(n), 0, 100);
}

/**
 * Inverse of normalizeLevelToPercent: convert a HomeKit percentage
 * (0..100) into the CCU's native 0..1 LEVEL representation that the
 * BLIND/DIMMER receiver channels accept on `setValue`.
 */
export function percentToLevelFraction(percent: number): number {
  return clamp(percent, 0, 100) / 100;
}

/** The subset of HAP characteristic props that bounds a value. */
export interface ValueProps {
  minValue?: number;
  maxValue?: number;
  validValues?: number[];
}

/**
 * Make a value acceptable for a characteristic (plan 8.5): numbers are
 * clamped to minValue / maxValue; with validValues only listed values
 * pass. Returns undefined when the value must not be pushed (non-finite,
 * or not a valid enum value). Booleans and strings pass unchanged.
 */
export function clampToProps(value: unknown, props: ValueProps | undefined): unknown {
  if (typeof value !== 'number') {
    return value;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (props?.validValues && props.validValues.length > 0) {
    return props.validValues.includes(value) ? value : undefined;
  }
  let v = value;
  if (typeof props?.minValue === 'number') {
    v = Math.max(props.minValue, v);
  }
  if (typeof props?.maxValue === 'number') {
    v = Math.min(props.maxValue, v);
  }
  return v;
}
