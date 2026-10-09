export function canonicalizeRecoveryRecipient(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return /^[0-9]{1,64}$/.test(digits) ? digits : null;
}