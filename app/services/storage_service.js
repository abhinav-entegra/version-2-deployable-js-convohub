import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "..", "public");
const avatarsDir = path.join(publicDir, "avatars");

/**
 * Saves a base64 image (Data URL) to a local file in public/avatars/.
 * Returns the relative public path (/avatars/...).
 */
export async function saveProfilePicture(base64Data, userId) {
  if (!base64Data || !base64Data.startsWith("data:image/")) {
    return base64Data; // Already a URL or not an image
  }

  try {
    const parts = base64Data.split(",");
    const match = parts[0].match(/image\/(\w+);base64/);
    const ext = match ? match[1] : "png";
    const buffer = Buffer.from(parts[1], "base64");
    
    const h = crypto.createHash("md5").update(`${userId}-${Date.now()}`).digest("hex").slice(0, 8);
    const fileName = `u${userId}_${h}.${ext}`;
    const filePath = path.join(avatarsDir, fileName);

    fs.writeFileSync(filePath, buffer);
    return `/avatars/${fileName}`;
  } catch (e) {
    console.error("[storage_service] Failed to save profile pic:", e);
    return base64Data; // Fallback to raw base64
  }
}
