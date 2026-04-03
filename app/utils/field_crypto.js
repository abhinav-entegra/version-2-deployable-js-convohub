import crypto from "crypto";

const PREFIX = "v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw || raw.length < 8) return null;
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  return crypto.createHash("sha256").update(String(raw), "utf8").digest();
}

/**
 * AES-256-GCM. When FIELD_ENCRYPTION_KEY is unset, values pass through (dev only).
 * Production: set FIELD_ENCRYPTION_KEY to 32-byte base64 or any string (hashed to 32 bytes).
 */
export function encryptMaybe(plain) {
  if (plain == null || plain === "") return plain;
  const text = String(plain);
  if (text.startsWith(PREFIX)) return text;
  const key = getKey();
  if (!key) return text;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, tag, enc]).toString("base64");
  return `${PREFIX}${out}`;
}

export function decryptMaybe(stored) {
  if (stored == null || stored === "") return stored;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s;
  const key = getKey();
  if (!key) return s;
  try {
    const raw = Buffer.from(s.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return s;
  }
}

export function decryptMessageRow(row) {
  if (!row) return row;
  return {
    ...row,
    content: decryptMaybe(row.content),
    file_path: row.file_path != null ? decryptMaybe(row.file_path) : row.file_path,
  };
}

export function decryptUserRow(row) {
  if (!row) return row;
  return {
    ...row,
    name: row.name != null ? decryptMaybe(row.name) : row.name,
    profile_pic_url: row.profile_pic_url != null ? decryptMaybe(row.profile_pic_url) : row.profile_pic_url,
  };
}
