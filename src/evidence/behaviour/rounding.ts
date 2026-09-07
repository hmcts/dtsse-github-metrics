export function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  const { numerator, denominator } = exactFraction(value);
  const scale = 10n ** BigInt(digits);
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;

  const scaled = magnitude * scale;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;

  const twiceRemainder = remainder * 2n;
  let rounded = quotient;
  if (twiceRemainder > denominator) {
    rounded = quotient + 1n;
  } else if (twiceRemainder === denominator && quotient % 2n === 1n) {
    rounded = quotient + 1n;
  }

  return Number(sign * rounded) / Number(scale);
}

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

  const mantissa = rawExponent === 0 ? rawMantissa : rawMantissa | 0x10000000000000n;
  const exponent = (rawExponent === 0 ? 1 : rawExponent) - 1075;

  const denominator = 1n << BigInt(-exponent);

  return { numerator: negative ? -mantissa : mantissa, denominator };
}
