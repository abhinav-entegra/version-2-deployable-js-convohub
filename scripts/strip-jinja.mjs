import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(__dirname, "../public/dashboard.template.html");
let s = fs.readFileSync(p, "utf8");
s = s.replace(/\{%[\s\S]*?%\}/g, "");
// Remove remaining {{ var }} in HTML (not inside JSON)
s = s.replace(/\{\{[\s\S]*?\}\}/g, "");
fs.writeFileSync(p, s);
console.log("Stripped Jinja from dashboard.template.html");
