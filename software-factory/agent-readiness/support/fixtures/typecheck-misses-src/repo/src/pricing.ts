import type { Cents } from "../types/money.ts";

export const ADULT_AGE: number = 18;

export function isAdult(age: number): boolean {
  return age >= ADULT_AGE;
}

export function discount(total: Cents): Cents {
  if (total >= 100) {
    return total - 10;
  }
  return total;
}

export function nextPage(page: number, lastPage: number): number {
  if (page < lastPage) {
    return page + 1;
  }
  return lastPage;
}

export function isValidCode(code: unknown): boolean {
  if (typeof code !== "string") {
    return false;
  }
  return code.length === 6;
}

export function parsePercent(text: string): number {
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TypeError("not a number");
  }
  return n / 100;
}
