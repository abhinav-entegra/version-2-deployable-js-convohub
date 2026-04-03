import fs from "fs";
import path from "path";
import { requireAuthPage, requireAdminPage } from "../middleware/auth_page.js";
import { buildAdminBoot } from "../services/admin_boot.js";

/**
 * GET /admin → redirect to dashboard shell.
 * GET /admin/dashboard — empty admin HTML (register before app.use("/admin", adminRouter)).
 * GET /admin/login is registered in main.js (before static + /admin mount).
 */
export function registerAdminConsoleRoute(app, publicDir) {
  const templatePath = path.join(publicDir, "admin-dashboard.template.html");

  app.get("/admin", (_req, res) => {
    res.redirect(302, "/admin/dashboard");
  });

  app.get("/admin/dashboard", requireAuthPage, requireAdminPage, async (req, res) => {
    try {
      const boot = await buildAdminBoot(req.user);
      let html = fs.readFileSync(templatePath, "utf8");
      html = html.replace("__ADMIN_DASHBOARD_BOOT_JSON__", JSON.stringify(boot));
      res.type("html").send(html);
    } catch (e) {
      console.error(e);
      res.status(500).send("Admin dashboard failed to render");
    }
  });
}
