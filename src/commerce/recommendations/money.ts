import type { InternationalizationRuntime } from "@modainteract/moda-interact-shared/internationalization";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export function isValidDecimal(value: string): boolean { return DECIMAL.test(value); }

export function currencyExponent(currency: string): number | null {
  try {
    const options = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions();
    const exponent = options.maximumFractionDigits;
    return typeof exponent === "number" && Number.isInteger(exponent) && exponent >= 0 && exponent <= 4 &&
      options.minimumFractionDigits === exponent ? exponent : null;
  } catch { return null; }
}

export function minorUnitsToDecimal(value: bigint, currency: string): string | null {
  const exponent = currencyExponent(currency);
  if (exponent === null || value < 0n) return null;
  if (exponent === 0) return value.toString();
  const padded = value.toString().padStart(exponent + 1, "0");
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

function minorUnits(value: string, exponent: number): bigint | null {
  if (!DECIMAL.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > exponent) return null;
  try { return BigInt(`${whole}${fraction.padEnd(exponent, "0")}`); }
  catch { return null; }
}

export function decimalToMinorUnits(value: string, currency: string): bigint | null {
  const exponent = currencyExponent(currency);
  return exponent === null ? null : minorUnits(value, exponent);
}

export function sumPurchaseSubtotal(lines: readonly Readonly<{ amountDecimal: string; quantity: number }>[], currency: string): bigint | null {
  let total = 0n;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return null;
    const amount = decimalToMinorUnits(line.amountDecimal, currency);
    if (amount === null) return null;
    total += amount * BigInt(line.quantity);
  }
  return total;
}

export function formatObservedMoney(value: string, currency: string, runtime: InternationalizationRuntime): string | null {
  const minor = decimalToMinorUnits(value, currency);
  const exponent = currencyExponent(currency);
  if (minor === null || exponent === null || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const numeric = Number(minor) / 10 ** exponent;
  if (!Number.isFinite(numeric) || decimalToMinorUnits(numeric.toFixed(exponent), currency) !== minor) return null;
  try { return runtime.formatMoney(numeric, currency); } catch { return null; }
}
