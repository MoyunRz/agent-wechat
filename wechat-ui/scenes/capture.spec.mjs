// Captures every scene at each of its viewports. A fresh simulator hub backs every
// test, so a scene sees only the data its own setup created, in the same order each
// run. The UI itself is served once per worker (see server.mjs).
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import { formatRoute } from "./routes.ts";
import { FIXED_TIME, scenes, viewports } from "./scenes.mjs";
import { startUiServer } from "./server.mjs";
import { seeder } from "./seed.mjs";
import { startStack } from "./stack.mjs";

/**
 * Translations captured after English. Each scene runs and is checked in English,
 * then switches language in place (as another window changing the setting would)
 * and is captured again as `<scene>@<viewport>@<language>`.
 */
const TRANSLATIONS = [{ name: "zh-CN", locale: "zh" }];

/** Gitignored, next to the Playwright results; see playwright.config.mjs. */
const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".scenes");

/** Frozen text and motion: nothing may change between the page settling and the screenshot. */
const FREEZE_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
`;

const test = base.extend({
  ui: [
    async ({}, use) => {
      const server = await startUiServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  stack: async ({ ui }, use) => {
    const stack = await startStack();
    ui.attach(stack);
    try {
      await use(stack);
    } finally {
      ui.attach(null);
      await stack.stop();
    }
  },
  context: async ({ context }, use) => {
    // The scenes are offline: only the scenes server on loopback may be reached.
    await context.route(
      (url) => ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname),
      (route) => route.abort("blockedbyclient"),
    );
    // Dates and times follow the simulator's clock; timers keep running.
    await context.clock.setFixedTime(FIXED_TIME);
    await context.addInitScript((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.addEventListener("DOMContentLoaded", () => document.head.append(style), { once: true });
    }, FREEZE_CSS);
    await use(context);
  },
});

/** Resolves once nothing the UI asked the hub for is still in flight. Open event streams do not count. */
function trackRequests(page) {
  const open = new Set();
  const relevant = (request) => {
    const path = new URL(request.url()).pathname;
    return (path.startsWith("/v1/") || path.startsWith("/client/v1/"))
      && !(request.headers().accept ?? "").includes("text/event-stream");
  };
  page.on("request", (request) => relevant(request) && open.add(request));
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => open.delete(request));
  return {
    idle: () => expect.poll(() => open.size, { message: "hub requests still in flight" }).toBe(0),
  };
}

/**
 * The page has stopped changing: warmed avatars and photos shown, fonts loaded, images
 * decoded, no hub requests pending, two frames painted.
 *
 * An avatar shows initials until its image arrives, and a photo a spinner or
 * placeholder, so initials of a contact whose avatar the hub has cached, or any
 * spinner or placeholder (every photo the scenes show is cached too), mean "not
 * yet". The UI only fetches what is on screen, so what a collapsed pane hides, or
 * what scrolled out of view, is not waited for.
 */
async function settle(page, requests, avatarInitials) {
  await page.waitForFunction((initials) => {
    const onScreen = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    };
    const avatarPending = [...document.querySelectorAll(".thread-avatar")].some((avatar) => {
      if (avatar.querySelector("img") || !onScreen(avatar)) return false;
      const fallback = avatar.querySelector(".fallback");
      return Boolean(fallback) && initials.includes(fallback.textContent.trim());
    });
    const photoPending = [...document.querySelectorAll(".image-spinner, .image-placeholder")].some(onScreen);
    return !avatarPending && !photoPending;
  }, avatarInitials);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))));
  await requests.idle();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await requests.idle();
}

/**
 * Switches the interface language in place. The UI reads its locale from the i18n
 * module, so the module's setter is called through the dev server's module graph
 * rather than through a reload, which would lose the state the scene reached.
 * Waiting for the rendered text to change also proves the module instance is the
 * one the mounted app uses.
 */
async function translate(page, locale, language) {
  const before = await page.evaluate(() => document.body.innerText);
  await page.evaluate(async (next) => {
    localStorage.setItem("vane.wechat.locale", next);
    const { setLocale } = await import("/src/i18n/index.ts");
    setLocale(next);
  }, locale);
  await page.waitForFunction(
    ({ previous, lang }) => document.documentElement.lang === lang && document.body.innerText !== previous,
    { previous: before, lang: language },
  );
}

/** The scenes server keeps the hub token out of the bundle: the page receives it once through `?auth=`. */
function sceneUrl(ui, stack, route) {
  return `${ui.origin}/?auth=${encodeURIComponent(stack.hub.token)}${formatRoute(route)}`;
}

for (const scene of scenes) {
  for (const viewport of scene.viewports) {
    test.describe(scene.name, () => {
      test.use({ viewport: viewports[viewport], hasTouch: viewport === "compact" });
      test(`${scene.name}@${viewport}`, async ({ page, ui, stack }, testInfo) => {
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const requests = trackRequests(page);
        const sim = seeder(stack);
        const world = await scene.setup(sim);
        await scene.prepare?.({ page });
        const route = { name: scene.route, server: stack.hub.serverId, ...scene.target(world) };
        await page.goto(sceneUrl(ui, stack, route));
        await page.waitForSelector(".app-shell, .desktop-connect", { state: "attached" });
        await page.waitForFunction(() => !document.querySelector(".boot-screen"));
        await scene.ready({ page, expect, world });
        await scene.actions?.({ page, expect, world });
        await settle(page, requests, sim.avatarInitials);
        const capture = async (name) => {
          const attachments = await argosScreenshot(page, name, {
            mask: scene.mask?.(page, world) ?? [],
            maskColor: "#000000",
          });
          // Keep a copy outside Playwright's result folders for looking at locally.
          const png = attachments.find((attachment) => attachment.contentType === "image/png");
          if (png) {
            await mkdir(join(outputRoot, "screenshots"), { recursive: true });
            await copyFile(png.path, join(outputRoot, "screenshots", `${name}.png`));
          }
        };
        const name = `${scene.name}@${viewport}`;
        await capture(name);
        for (const language of TRANSLATIONS) {
          await translate(page, language.locale, language.name);
          await settle(page, requests, sim.avatarInitials);
          await capture(`${name}@${language.name}`);
        }
        expect(errors, "uncaught page errors").toEqual([]);
      });
    });
  }
}
