import { randomBytes } from "crypto";

export function buildId(...parts: string[]): string {
  return `${parts.join("-")}-${randomBytes(3).toString("hex")}`;
}
