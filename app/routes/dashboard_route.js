import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { requireAuthPage, requireClientPage } from "../middleware/auth_page.js";
import { buildDashboardBoot } from "../services/dashboard_boot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, "../../public/dashboard.template.html");

export function registerDashboardRoute(app) {
  app.get("/dashboard", requireAuthPage, requireClientPage, async (req, res) => {
    try {
      const boot = await buildDashboardBoot(req.user);
      let html = fs.readFileSync(templatePath, "utf8");
      html = html.replace("__DASHBOARD_BOOT_JSON__", JSON.stringify(boot));
      res.type("html").send(html);
    } catch (e) {
      console.error(e);
      res.status(500).send("Dashboard failed to render");
    }
  });
}
