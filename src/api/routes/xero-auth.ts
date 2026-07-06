import type { FastifyInstance } from "fastify";
import { xeroService } from "../../services/xero.service.js";

export async function registerXeroAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/xero/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    if (query.error) {
      const detail = query.error_description ?? query.error;
      return reply
        .code(400)
        .type("text/html")
        .send(errorPage(`${query.error}: ${detail}`));
    }

    if (!query.code || !query.state) {
      return reply.code(400).type("text/html").send(errorPage("Missing code or state from Xero"));
    }

    try {
      const state = JSON.parse(Buffer.from(query.state, "base64url").toString()) as {
        organizationId: string;
        organizationSlug: string;
      };

      await xeroService.handleOAuthCallback(query.code, state.organizationId);

      return reply.type("text/html").send(successPage(state.organizationSlug));
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth failed";
      return reply.code(500).type("text/html").send(errorPage(message));
    }
  });
}

function successPage(slug: string): string {
  return `<!DOCTYPE html><html><head><title>Xero Connected</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;text-align:center}
.ok{color:#16a34a;font-size:48px} a{color:#2563eb}</style></head><body>
<div class="ok">✓</div><h1>Xero connected</h1>
<p>Organization <strong>${slug}</strong> is now linked to Xero.</p>
<p><a href="/admin/#/org/${slug}/integrations">Return to Admin → Integrations</a></p>
<script>setTimeout(()=>location.href='/admin/#/org/${slug}/integrations',3000)</script>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><head><title>Xero Error</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;text-align:center}
.err{color:#dc2626}</style></head><body>
<h1 class="err">Connection failed</h1><p>${message}</p>
<p><a href="/admin/">Return to Admin</a></p></body></html>`;
}
