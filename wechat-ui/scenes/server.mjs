// The wechat-ui Vite dev server the scenes load the UI from. It forwards the
// app's API calls (`/v1`, and `/client/v1` for the address the app infers before
// it has seen a token) to the hub of the scene in progress, so one server (and
// one warm module cache) can serve a fresh synthetic hub per scene.
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
  const json = (res, status, value) => {
    res.statusCode = status;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };
  const plugin = {
    name: "scene-hub",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/v1/") && !url.startsWith("/client/v1/")) return next();
        if (!current) return json(res, 503, {});
        const target = new URL(current.hub.endpoint);
        const api = url.startsWith("/client/v1/");
        const path = api ? url.replace(/^\/client\/v1/, "/v1") : url;
        // The page normally carries the hub token in session storage and sends
        // it itself; attach the scene's token for callers that do not.
        const headers = { ...req.headers };
        if (!headers.authorization) headers.authorization = `Bearer ${current.hub.token}`;
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
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return {
    origin,
    /** Points the UI at a stack until the next call; `null` detaches it. */
    attach(stack) {
      current = stack;
    },
    close: () => server.close(),
  };
}
