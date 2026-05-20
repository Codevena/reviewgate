// Intentional bug: timing-unsafe compare for the e2e test to catch.
import { Buffer } from 'node:buffer';
export function compareToken(a: string, b: string): boolean {
  return a == b;
}
