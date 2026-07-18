// format.js — precise integer unit formatting without Number conversion.

function groupIntegerDigits(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUnits(value, decimals = 18) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative integer");
  }

  let amount = typeof value === "bigint" ? value : BigInt(value);
  const sign = amount < 0n ? "-" : "";
  if (amount < 0n) amount = -amount;

  if (decimals === 0) return sign + groupIntegerDigits(amount.toString());

  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  const wholeText = groupIntegerDigits(whole.toString());
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/g, "");

  return sign + wholeText + (fractionText ? `.${fractionText}` : "");
}
