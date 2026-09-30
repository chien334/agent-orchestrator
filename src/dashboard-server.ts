import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.js";

const files = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
]);

export async function createDashboardServer(repo: string): Promise<Server> {
  const manager = new Orchestrator(repo);
  await manager.listRunSnapshots(); // Fail early if this is not a Git repository.
  const assets = new Map(
    await Promise.all(
      [...files].map(
        async ([route, file]) =>
          [
            route,
            {
              body: await readFile(
                fileURLToPath(
                  new URL(`../public/${file.name}`, import.meta.url),
                ),
              ),
              type: file.type,
            },
          ] as const,
      ),
    ),
  );

  return createServer(async (req, res) => {
    const port = res.socket?.localPort ?? 0;
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        req.headers.host ?? "",
      )
    ) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (req.method !== "GET") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    if (req.url === "/api/runs") {
      try {
        const runs = await manager.listRunSnapshots();
        res
          .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ runs }));
      } catch {
        res
          .writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ error: "Could not read run reports" }));
      }
      return;
    }
    const asset = assets.get(req.url ?? "");
    if (!asset) {
      res.writeHead(404).end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
  });
}
