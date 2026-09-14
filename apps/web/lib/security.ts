import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [version, salt, hash] = encoded.split(":");
  if (
    version !== "scrypt-v1" ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(hash ?? "")
  )
    return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(hash, "hex"),
  );
}
export function canonicalUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
