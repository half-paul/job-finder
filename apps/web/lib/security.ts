import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
// Hashing and URL canonicalization live in the shared package so the worker and
// the web app compute identical session, source and job identities.
export { canonicalUrl, digest } from "@jobfinder/shared/hash";
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
