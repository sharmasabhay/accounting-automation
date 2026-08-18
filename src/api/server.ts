import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { registerWhatsAppRoutes } from "./webhooks/whatsapp.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerXeroAuthRoutes } from "./routes/xero-auth.js";
import { registerWhatsAppOnboardingRoutes } from "./routes/whatsapp-onboarding.js";
import { prisma } from "../db/client.js";

const PUBLIC_PATHS = [
  "/health",
  "/webhooks/whatsapp",
  "/auth/xero/callback",
  "/admin",
  "/onboarding/whatsapp",
];
const ADMIN_ROOT = path.join(config.projectRoot, "public/admin");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export async function createServer() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(cors, { origin: true });

  app.get("/admin", async (_request, reply) => {
    const html = await fs.readFile(path.join(ADMIN_ROOT, "index.html"));
    return reply.type("text/html").send(html);
  });

  app.get("/admin/*", async (request, reply) => {
    const relPath = request.url.replace(/^\/admin\/?/, "") || "index.html";
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(ADMIN_ROOT, safePath);

    if (!filePath.startsWith(ADMIN_ROOT)) {
      return reply.code(403).send("Forbidden");
    }

    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      return reply.type(MIME_TYPES[ext] ?? "application/octet-stream").send(content);
    } catch {
      return reply.code(404).send("Not found");
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    const isPublic = PUBLIC_PATHS.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    );

    if (!isPublic) {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (token !== config.API_TOKEN) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    dryRun: config.DRY_RUN,
    multiTenant: true,
    adminUi: "/admin",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/workflows", async () => {
    return prisma.workflowRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        organizationId: true,
        type: true,
        status: true,
        currentStep: true,
        triggerRef: true,
        createdAt: true,
        completedAt: true,
      },
    });
  });

  app.get("/api/audit", async () => {
    return prisma.auditLogEntry.findMany({
      orderBy: { timestampUtc: "desc" },
      take: 50,
      select: {
        id: true,
        organizationId: true,
        actor: true,
        sourceChannel: true,
        triggerEvent: true,
        outcome: true,
        timestampUtc: true,
      },
    });
  });

  await registerOrganizationRoutes(app);
  await registerXeroAuthRoutes(app);
  await registerWhatsAppRoutes(app);
  await registerWhatsAppOnboardingRoutes(app);

  return app;
}

export async function startServer() {
  const app = await createServer();

  await app.listen({
    port: config.PORT,
    host: config.HOST,
  });

  logger.info(
    { host: config.HOST, port: config.PORT, admin: `http://${config.HOST}:${config.PORT}/admin` },
    "Omakase API server started (multi-tenant + admin UI)"
  );

  return app;
}
