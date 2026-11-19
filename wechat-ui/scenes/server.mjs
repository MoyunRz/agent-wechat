// The wechat-ui Vite dev server the scenes load the UI from. It answers the
// legacy `/__dev/*` bootstrap and forwards the app's `/client/v1` API (plus
// `/v1` for older callers) to a hub, and the hub can be swapped between scenes so
// one server (and one warm module cache) serves a fresh synthetic hub per scene.
import http from "node:http";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Vite treats port 0 as "default", so ask the OS for a free port first. */
function freePort() {
  return new Promise((done, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

export async function startUiServer() {
  /** The stack the scene in progress runs against. */
  let current = null;
  let origin = "";
  const json = (res, status, value) => {
    res.statusCode = status;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };
  const plugin = {
    name: "scene-hub",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url.startsWith("/v1/") || url.startsWith("/client/v1/")) {
          if (!current) return json(res, 503, {});
          const target = new URL(current.hub.endpoint);
          const api = url.startsWith("/client/v1/");
          const path = api ? url.replace(/^\/client\/v1/, "/v1") : url;
          // The standalone UI keeps its token in session storage; the scene server
          // is the dev proxy that attaches the current hub's token.
          const headers = { ...req.headers };
          if (api && !headers.authorization) headers.authorization = `Bearer ${current.hub.token}`;
          const upstream = http.request(
            { host: target.hostname, port: target.port, method: req.method, path, headers },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", () => {
            if (!res.headersSent) json(res, 502, {});
            else res.destroy();
          });
          res.on("close", () => upstream.destroy());
          req.pipe(upstream);
          return;
        }
        if (!url.startsWith("/__dev/")) return next();
        if (!current) return json(res, 503, {});
        const path = url.split("?")[0];
        if (path === "/__dev/session" && req.method === "GET")
          return json(res, 200, { endpoint: origin, token: current.hub.token, simulator: true });
        if (path === "/__dev/connections") return json(res, 200, []);
        if (path === "/__dev/state" && req.method === "GET") {
          try {
            return json(res, 200, { clock: await current.clock() });
          } catch {
            return json(res, 503, {});
          }
        }
        if (path === "/__dev/control" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 16384) throw new Error("too large");
            }
            await current.control(JSON.parse(body));
            return json(res, 200, {});
          } catch {
            return json(res, 400, {});
          }
        }
        return json(res, 404, {});
      });
    },
  };
  const server = await createServer({
    root: packageDir,
    cacheDir: join(packageDir, "node_modules/.vite-scenes"),
    configFile: join(packageDir, "vite.config.ts"),
    logLevel: "warn",
    clearScreen: false,
    server: { host: "127.0.0.1", port: await freePort(), strictPort: true, hmr: false, watch: null },
    plugins: [plugin],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return {
    origin,
    /** Points the UI at a stack until the next call; `null` detaches it. */
    attach(stack) {
      current = stack;
    },
    close: () => server.close(),
  };
}
