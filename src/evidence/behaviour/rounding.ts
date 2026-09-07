/**
 * Rounding that matches Python's `round(value, digits)`.
 *
 * This exists because the two languages disagree, and the disagreement is visible in a report. Python
 * rounds half to EVEN; JavaScript's `Math.round` rounds half UP. `8.25` is exactly representable as a
 * double, so it is a genuine tie: Python answers `8.2` and `Math.round(8.25 * 10) / 10` answers `8.3`.
 *
 * Where that shows up: `ratePercentage` rounds to one decimal and `percentile` to three, and the trend
 * compares a metric between windows. A last-digit difference is enough to report a rate as having moved
 * when it did not, so every `round()` in the Python is this function here.
 *
 * The comparison is done on the EXACT binary value rather than on a scaled float. Scaling first
 * (`value * 10 ** digits`) introduces its own error, which would invent ties that do not exist and hide
 * ties that do — `2.675` is really 2.67499999999999982…, so it is not a tie at two decimals and must
 * round down, while a scaled comparison could read it either way. Decomposing the double into a BigInt
 * fraction settles it with no rounding of our own.
 */
export function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  const { numerator, denominator } = exactFraction(value);
  const scale = 10n ** BigInt(digits);
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;

  // The quotient and remainder of |value| * 10^digits, exactly.
  const scaled = magnitude * scale;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;

  // Compare the remainder against half the denominator without dividing, so no precision is lost.
  const twiceRemainder = remainder * 2n;
  let rounded = quotient;
  if (twiceRemainder > denominator) {
    rounded = quotient + 1n;
  } else if (twiceRemainder === denominator && quotient % 2n === 1n) {
    // The tie, and the whole reason this function exists: round to the even neighbour.
    rounded = quotient + 1n;
  }

  return Number(sign * rounded) / Number(scale);
}

/**
 * A double as an exact fraction.
 *
 * Every finite double is a dyadic rational — `mantissa * 2^exponent` — so this is exact rather than an
 * approximation, and it is what lets the tie test above be a comparison of integers.
 */
function exactFraction(value: number): { numerator: bigint; denominator: bigint } {
  if (Number.isInteger(value)) {
    return { numerator: BigInt(value), denominator: 1n };
  }

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);

  const negative = bits >> 63n === 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xfffffffffffffn;

  // Subnormals carry no implicit leading bit and sit at a fixed exponent.
  const mantissa = rawExponent === 0 ? rawMantissa : rawMantissa | 0x10000000000000n;
  const exponent = (rawExponent === 0 ? 1 : rawExponent) - 1075;

  // `exponent` is always negative here, so there is no positive case to handle: a double is
  // `mantissa * 2^exponent` with an integer mantissa, so a non-negative exponent makes the value an integer —
  // and the `Number.isInteger` return above has already taken every one of those. The branch that used to
  // shift the numerator left was unreachable, which is how it came to be the one uncovered line in this file.
  const denominator = 1n << BigInt(-exponent);

  return { numerator: negative ? -mantissa : mantissa, denominator };
}
