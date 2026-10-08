export type PaidIncludedAllowanceCounter = {
  grantedQuantity: number;
  currentAllowanceQuantity: number | null;
  committedQuantity: number;
  reservedQuantity: number;
  forfeitedQuantity: number;
};

export function availablePaidIncludedQuantity(
  counter: PaidIncludedAllowanceCounter,
): number {
  const allowance = counter.currentAllowanceQuantity ?? counter.grantedQuantity;
  return Math.max(
    allowance
      - counter.committedQuantity
      - counter.reservedQuantity
      - counter.forfeitedQuantity,
    0,
  );
}

export function isValidPaidIncludedAllowanceCounter(
  counter: PaidIncludedAllowanceCounter,
): boolean {
  const quantities = [
    counter.grantedQuantity,
    counter.committedQuantity,
    counter.reservedQuantity,
    counter.forfeitedQuantity,
  ];
  if (quantities.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return false;
  }
  if (
    counter.committedQuantity
      + counter.reservedQuantity
      + counter.forfeitedQuantity
    > counter.grantedQuantity
  ) {
    return false;
  }
  return counter.currentAllowanceQuantity === null
    || (Number.isSafeInteger(counter.currentAllowanceQuantity)
      && counter.currentAllowanceQuantity >= 0
      && counter.currentAllowanceQuantity <= counter.grantedQuantity);
}