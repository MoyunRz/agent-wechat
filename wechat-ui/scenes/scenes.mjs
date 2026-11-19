// The scenes the visual review captures: a name, the simulator data it needs, the
// route it opens and what to wait for. Plain data and functions with no browser
// dependency, so listing.mjs can list them without Playwright.
//
// A scene opens `route` (a name from routeTable) with the parameters `target`
// returns, once `setup` has seeded the simulator. `ready` waits for the screen to
// be complete using roles and text; `actions` reaches states no address expresses.
// Screenshots are named `<scene>@<viewport>`, which is how Argos matches them to the
// baseline, so renaming a scene or a viewport shows up as removed plus added. Each
// scene is also captured in every translation as `<scene>@<viewport>@<language>`
// (see capture.spec.mjs); `ready` and `actions` stay in English.
import { ACCOUNT, SPARE } from "./accounts.mjs";
import { desktopBridge, LEFTOVER_HUB_SETTINGS } from "./desktop.mjs";

/** Desktop, phone and compact phone sizes for visual review. */
export const viewports = {
  desktop: { width: 1280, height: 800 },
  narrow: { width: 390, height: 844 },
  compact: { width: 320, height: 700 },
};

/**
 * The browser clock for every scene, a quarter of an hour after the simulator's
 * fixed start (1700000000, 2023-11-14T22:13:20Z). Messages are stamped from the
 * simulator clock, so this makes "today" the day they were sent.
 */
export const FIXED_TIME = "2023-11-14T22:30:00Z";

/** Signs in the account and creates the conversations most scenes show. Returns the identifiers scenes need. */
async function standardWorld(sim) {
  await sim.addAccount(ACCOUNT);
  await sim.signIn(ACCOUNT);
  // Initials of the fallback avatars the UI shows until the hub image arrives.
  // ThreadAvatar.initials() keeps the first character only.
  await sim.warmAvatars(["sim_mei", "sim_daniel"], ["M", "D"]);
  await sim.advance(120);
  await sim.inbound("sim_mei", "Are we still on for lunch tomorrow?");
  await sim.advance(45);
  await sim.inbound("sim_mei", "Yes, noon works. Where should we meet?", { self: true });
  await sim.advance(30);
  await sim.inbound("sim_mei", "I booked the place near the station");
  await sim.advance(20);
  await sim.media("sim_mei", "image");
  await sim.settled("sim_mei", 5);
  await sim.warmPhotos("sim_mei");
  await sim.advance(240);
  await sim.inbound("sim_daniel", "The draft is ready for review");
  await sim.advance(15);
  await sim.inbound("sim_daniel", "I left a few comments in the doc");
  await sim.settled("sim_daniel", 2);
  const group = await sim.createGroup("Weekend trip", ["sim_mei", "sim_daniel"]);
  await sim.advance(60);
  await sim.inbound(group, "Who is driving on Saturday?", { sender: "sim_mei" });
  await sim.advance(25);
  await sim.inbound(group, "I can take my car, it fits four", { sender: "sim_daniel" });
  await sim.advance(40);
  await sim.media(group, "image", { sender: "sim_mei" });
  await sim.settled(group, 4);
  await sim.warmPhotos(group);
  const mei = await sim.messages("sim_mei");
  return {
    mei: "sim_mei",
    daniel: "sim_daniel",
    group,
    booked: mei.find((message) => message.body === "I booked the place near the station").id,
    photo: mei.find((message) => message.type === 3).id,
  };
}

/** A row of the conversation list, found by the conversation's name rather than its preview text. */
const row = (page, name) => page.locator(".thread-item").filter({ has: page.getByText(name, { exact: true }) });
/** A row of the contact list, found by the contact's display name. */
const contactRow = (page, name) => page.locator(".contact-row").filter({ has: page.getByText(name, { exact: true }) });
/**
 * The sign-in code is random on every run; the countdown beside it is not. Masks
 * select by class, not text, so they also apply to the translated captures.
 */
const qr = (page) => [page.locator(".qr-frame img")];

/** Synthetic request conversations for visual review; never contact the live service. */
const requestSceneRows = [
  { id: "fr_scene_casey", peerId: "sim_casey", displayName: "Casey Morgan", direction: "incoming", message: "Hello, we met at the book club.", updatedAt: 1700000800, version: "scene-incoming-v1", isContact: false, actionable: true, attention: true, state: "request_received", history: [{ serverId: "123", message: "Hello, we met at the book club.", createdAt: 1700000800, direction: "incoming" }] },
  { id: "fr_scene_jordan", peerId: "sim_jordan", displayName: "Jordan Lee", direction: "outgoing", message: "Let's keep in touch.", updatedAt: 1700000700, version: "scene-outgoing-v1", isContact: false, actionable: false, attention: false, state: "request_sent", history: [{ serverId: "0", message: "Let's keep in touch.", createdAt: 1700000700, direction: "outgoing" }] },
];

/** Serves the synthetic inbox rows at the daemon's boundary. */
async function mockRequests(page) {
  await page.route("**/v1/accounts/*/contact-requests*", (route) => {
    if (route.request().method() !== "GET")
      return route.continue();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/contact-requests"))
      return route.fulfill({ json: { items: requestSceneRows, nextCursor: null, pendingIncomingCount: 1, sourceGeneration: "scene", coverage: {}, asOfEventCursor: "0" } });
    const row = requestSceneRows.find(item => path.endsWith(`/contact-requests/${item.id}`));
    return row ? route.fulfill({ json: row }) : route.continue();
  });
}

export const scenes = [
  {
    name: "login-qr",
    route: "login",
    description: "Sign-in screen of an account that is not signed in, showing the QR code to scan.",
    viewports: ["desktop", "narrow"],
    setup: async (sim) => {
      await sim.addAccount(SPARE);
      return {};
    },
    target: () => ({ account: SPARE.id }),
    ready: async ({ page, expect }) => {
      await expect(page.getByRole("heading", { name: "Sign in with WeChat QR code" })).toBeVisible();
      await expect(page.getByRole("img", { name: "WeChat sign-in QR code" })).toBeVisible();
    },
    mask: qr,
  },
  {
    name: "chat-list",
    route: "chats",
    description: "The inbox with its filter tabs and unread badges, and the welcome pane beside it.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      for (const name of ["Mei Chen", "Daniel Park", "Weekend trip"]) await expect(row(page, name)).toBeVisible();
      await expect(page.locator(".filter-tabs").getByRole("button", { name: "All", exact: true })).toHaveClass(/active/);
      await expect(page.locator(".unread-badge").first()).toBeVisible();
    },
  },
  {
    name: "chat-filters",
    route: "chats",
    description: "The conversation filter tabs, the collapsed service categories and their unread badges.",
    viewports: ["desktop", "compact"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    prepare: async ({ page }) => {
      // The simulator has no official accounts or WeCom support chats. Add those
      // rows at the thread-list boundary while keeping its DM and group rows.
      await page.route(/\/threads(?:\?.*)?$/, async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const threads = await response.json();
        for (const [id, displayName, unreadCount, text] of [
          ["gh_scene_library", "City Library", 3, "New events this weekend"],
          ["sim_scene_metro@openim", "Metro Alerts", 12, "Your trip receipt is ready"],
        ]) {
          threads.items.push({
            id, peerId: id, accountId: ACCOUNT.id, displayName, unreadCount,
            kind: "direct", readStateVersion: "0", history: null,
            lastMessage: { id: `${id}-1`, type: 1, text, senderId: id, senderName: displayName, direction: "incoming", createdAt: null },
          });
        }
        await route.fulfill({ response, json: threads });
      });
    },
    ready: async ({ page, expect }) => {
      for (const name of ["Mei Chen", "Daniel Park", "Weekend trip"])
        await expect(row(page, name)).toBeVisible();
      // Service notifications collapse into one aggregate row each.
      const categories = page.locator(".thread-item.category-row");
      await expect(categories).toHaveCount(2);
      await expect(categories.filter({ hasText: "Service Notifications" })).toBeVisible();
      await expect(categories.filter({ hasText: "WeCom" })).toBeVisible();
      await expect(row(page, "City Library")).toHaveCount(0);
      await expect(row(page, "Metro Alerts")).toHaveCount(0);
    },
    actions: async ({ page, expect }) => {
      const tabs = page.locator(".filter-tabs");
      const tab = (name) => tabs.getByRole("button", { name, exact: true });
      const all = tab("All");
      const unread = tab("Unread");
      const direct = tab("Direct");
      const groups = tab("Groups");
      const wecom = tab("WeCom");
      const service = tab("Service Notifications");
      const categoryRows = page.locator(".thread-item.category-row");
      const serviceCategory = categoryRows.filter({ hasText: "Service Notifications" });
      const wecomCategory = categoryRows.filter({ hasText: "WeCom" });
      const mei = row(page, "Mei Chen");
      const daniel = row(page, "Daniel Park");
      const trip = row(page, "Weekend trip");
      const library = row(page, "City Library");
      const metro = row(page, "Metro Alerts");

      // Opening a category row reveals its indented conversations.
      await expect(all).toHaveClass(/active/);
      await serviceCategory.click();
      await expect(library).toBeVisible();
      await expect(library).toHaveClass(/nested/);
      await wecomCategory.click();
      await expect(metro).toBeVisible();
      await expect(metro).toHaveClass(/nested/);

      await direct.click();
      await expect(direct).toHaveClass(/active/);
      await expect(mei).toBeVisible();
      await expect(daniel).toBeVisible();
      await expect(trip).toHaveCount(0);
      await expect(library).toHaveCount(0);
      await unread.click();
      await expect(unread).toHaveClass(/active/);
      await expect(trip).toBeVisible();
      await expect(metro).toBeVisible();
      await groups.click();
      await expect(groups).toHaveClass(/active/);
      await expect(trip).toBeVisible();
      await expect(mei).toHaveCount(0);
      await wecom.click();
      await expect(wecom).toHaveClass(/active/);
      await expect(metro).toBeVisible();
      await expect(mei).toHaveCount(0);
      await service.click();
      await expect(service).toHaveClass(/active/);
      await expect(library).toBeVisible();
      await expect(metro).toHaveCount(0);
      await expect(mei).toHaveCount(0);

      // Back to every conversation: the categories keep their expanded state.
      await all.click();
      await expect(all).toHaveClass(/active/);
      await expect(trip).toBeVisible();
      await expect(library).toBeVisible();
      await expect(metro).toBeVisible();

      const search = page.getByPlaceholder("Search chats");
      await search.fill("Mei");
      await expect(mei).toBeVisible();
      await expect(library).toHaveCount(0);
      await expect(categoryRows).toHaveCount(0);
      await search.clear();
      await search.blur();
      await expect(library).toBeVisible();
    },
  },
  {
    name: "direct-chat",
    route: "chat",
    description: "A direct conversation with text from both sides and a photo.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: (world) => ({ account: ACCOUNT.id, thread: world.mei }),
    ready: async ({ page, expect }) => {
      await expect(page.locator(".chat-header h2")).toHaveText("Mei Chen");
      await expect(page.getByText("I booked the place near the station")).toBeVisible();
      await expect(page.getByText("Yes, noon works. Where should we meet?")).toBeVisible();
      await expect(page.locator("img.image-content")).toHaveCount(1);
    },
  },
  {
    name: "group-chat",
    route: "chat",
    description: "A group conversation where each message names its sender, ending in a photo.",
    viewports: ["desktop"],
    setup: standardWorld,
    target: (world) => ({ account: ACCOUNT.id, thread: world.group }),
    ready: async ({ page, expect }) => {
      await expect(page.getByText("Who is driving on Saturday?")).toBeVisible();
      await expect(page.getByText("I can take my car, it fits four")).toBeVisible();
      await expect(page.locator("img.image-content")).toHaveCount(1);
    },
  },
  {
    name: "quoted-replies",
    route: "chat",
    description: "Quoted replies show the author name supplied with the quote above the quoted excerpt.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: (world) => ({ account: ACCOUNT.id, thread: world.group }),
    prepare: async ({ page }) => {
      // Synthetic API payloads exercise the browser's normal message-loading path.
      await page.route(/\/threads\/[^/]+\/messages(?:\?.*)?$/, async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const data = await response.json();
        const authors = ["Example Member", "Mei Chen", "Daniel Park"];
        data.items = data.items.slice(0, 3).map((message, index) => ({
          ...message, type: 49, appMessageType: 57, body: `Reply ${index + 1}`,
          quote: {
            type: 1,
            state: "embedded",
            serverId: `9900${index}`,
            embeddedText: `Quoted excerpt ${index + 1}`,
            senderName: authors[index],
          },
        }));
        await route.fulfill({ response, json: data });
      });
    },
    ready: async ({ page, expect }) => {
      const authors = page.locator(".quote-sender");
      await expect(authors).toHaveCount(3);
      for (const author of ["Example Member", "Mei Chen", "Daniel Park"])
        await expect(authors.filter({ hasText: new RegExp(`^${author}$`) })).toHaveCount(1);
    },
  },
  {
    name: "message-deep-link",
    route: "message",
    description: "A conversation opened at one message, which is scrolled into view.",
    viewports: ["desktop"],
    setup: async (sim) => {
      const world = await standardWorld(sim);
      // Enough later messages that the target starts above the fold, so the
      // screenshot proves the deep link scrolled to it rather than to the end.
      for (let index = 1; index <= 14; index += 1) {
        await sim.advance(10);
        await sim.inbound(world.mei, `Later message ${index}`);
      }
      await sim.settled(world.mei, 14);
      return world;
    },
    target: (world) => ({ account: ACCOUNT.id, thread: world.mei, message: world.booked }),
    ready: async ({ page, expect, world }) => {
      const target = page.locator(`[data-mid="${world.booked}"]`);
      await expect(target).toHaveCount(1);
      await expect(target).toBeInViewport();
      await expect(page.locator("[data-mid]").last()).not.toBeInViewport();
    },
  },
  {
    name: "image-lightbox",
    route: "media",
    description: "The photo viewer opened over a conversation, on the photo Mei sent.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: (world) => ({ account: ACCOUNT.id, thread: world.mei, message: world.photo }),
    ready: async ({ page, expect }) => {
      await expect(page.locator(".chat-header h2")).toHaveText("Mei Chen");
      await expect(page.locator("img.image-content")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.locator("img.image-content").click();
      await expect(page.locator(".lightbox img")).toBeVisible();
    },
  },
  {
    name: "chat-info",
    route: "info",
    description: "Details of a group conversation with its cached members and conversation flags.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: (world) => ({ account: ACCOUNT.id, thread: world.group }),
    ready: async ({ page, expect }) => {
      const details = page.locator(".chat-details");
      await expect(details).toBeVisible();
      await expect(details.locator(".details-head strong")).toHaveText("Conversation details");
      await expect(details.locator(".details-profile strong")).toHaveText("Weekend trip");
      await expect(details.getByText("Conversation type")).toBeVisible();
    },
    // The conversation ID of a group is random.
    mask: (page) => [page.locator(".chat-details code")],
  },
  {
    name: "contacts",
    route: "contacts",
    description: "The contact list of an account, grouped by contact kind.",
    viewports: ["desktop"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      await expect(page.locator(".contacts-panel h2")).toHaveText("Contacts");
      await expect(contactRow(page, "Mei Chen")).toBeVisible();
      await expect(contactRow(page, "Daniel Park")).toBeVisible();
    },
  },
  {
    name: "friend-requests",
    route: "requests",
    description: "The friend-request inbox with received and sent requests and its direction tabs.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    prepare: async ({ page }) => { await mockRequests(page); },
    ready: async ({ page, expect }) => {
      const panel = page.locator(".requests-panel");
      await expect(panel.locator("h2")).toHaveText("Friend requests");
      await expect(panel.getByText("Casey Morgan", { exact: true })).toBeVisible();
      await expect(panel.getByText("Jordan Lee", { exact: true })).toBeVisible();
      await expect(panel.locator(".request-tabs .request-tab.active")).toHaveText("All");
    },
  },
  {
    name: "friend-request-review",
    route: "requests",
    description: "One request opened from the inbox, with its greeting, history and accept action.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    prepare: async ({ page }) => { await mockRequests(page); },
    ready: async ({ page, expect }) => {
      await expect(page.locator(".requests-panel .requests-row").filter({ hasText: "Casey Morgan" })).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.locator(".requests-row").filter({ hasText: "Casey Morgan" }).click();
      const dialog = page.locator(".requests-detail");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Request history")).toBeVisible();
      await expect(dialog.getByText("Relationship privacy")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    },
  },
  {
    name: "contact-details",
    route: "contacts",
    description: "A saved contact card with remark editing and relationship privacy, opened from the contact list.",
    viewports: ["desktop", "compact"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      await expect(contactRow(page, "Mei Chen")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      const target = contactRow(page, "Mei Chen");
      await target.hover();
      await target.locator(".contact-details").click();
      const card = page.locator(".contact-card");
      await expect(card).toBeVisible();
      await expect(card.locator(".contact-field input")).toBeVisible();
      await expect(card.getByText("Relationship privacy")).toBeVisible();
    },
  },
  {
    name: "contact-details-remove",
    route: "contacts",
    description: "The contact card's remove confirmation, which keeps chat history.",
    viewports: ["desktop", "compact"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      await expect(contactRow(page, "Mei Chen")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      const target = contactRow(page, "Mei Chen");
      await target.hover();
      await target.locator(".contact-details").click();
      const card = page.locator(".contact-card");
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Remove contact", exact: true }).click();
      await expect(card.getByText("Remove this person from your contacts. Your chat history stays.")).toBeVisible();
    },
  },
  {
    name: "add-contact",
    route: "new-chat",
    description: "Server discovery and the greeting and privacy choices shown before a friend request is sent.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    prepare: async ({ page }) => {
      await page.route("**/v1/accounts/*/search/contacts", route => route.fulfill({
        json: { displayName: "avery.example", recipientRef: "scene-only-reference", expiresAt: 1700001400, source: "wechat", request: null, contactId: null },
      }));
    },
    ready: async ({ page, expect }) => {
      await expect(page.locator(".contact-dialog .contact-head strong")).toHaveText("New chat");
    },
    actions: async ({ page, expect }) => {
      const dialog = page.locator(".contact-dialog");
      await dialog.getByPlaceholder("Search contacts or enter a WeChat ID").fill("avery.example");
      await dialog.locator(".discovery-trigger").click();
      await expect(dialog.getByText("avery.example", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Add friend", exact: true }).click();
      await expect(dialog.getByPlaceholder("Write a greeting; they will see it")).toBeVisible();
    },
  },
  {
    name: "omni-search",
    route: "chats",
    description: "The ⌘K search dialog with contacts, groups and matching messages in separate sections.",
    viewports: ["desktop"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    prepare: async ({ page }) => {
      // Only the account-wide message search; conversation history keeps its own route.
      await page.route(/\/v1\/accounts\/[^/]+\/messages\?/, async route => route.fulfill({
        json: { items: [{ id: "scene_message", accountId: ACCOUNT.id, threadId: "sim_mei", serverId: "9007199254740999", senderId: "sim_mei", type: 1, direction: "incoming", body: "Are we still on for lunch tomorrow?", createdAt: "2023-11-14T22:15:00Z", version: "scene" }], nextCursor: null },
      }));
    },
    ready: async ({ page, expect }) => {
      await expect(row(page, "Mei Chen")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.keyboard.press("Control+k");
      const dialog = page.locator(".global-search-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("Search contacts, groups or messages").fill("lunch");
      await expect(dialog.getByText("Are we still on for lunch tomorrow?")).toBeVisible();
    },
  },
  {
    name: "new-chat",
    route: "new-chat",
    description: "The dialog for starting a direct conversation, searching the contact list.",
    viewports: ["desktop"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      const dialog = page.locator(".contact-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".contact-head strong")).toHaveText("New chat");
    },
    actions: async ({ page, expect }) => {
      const dialog = page.locator(".contact-dialog");
      await dialog.getByPlaceholder("Search contacts or enter a WeChat ID").fill("Daniel");
      const item = dialog.locator(".contact-item").filter({ hasText: "Daniel Park" });
      await expect(item).toBeVisible();
    },
  },
  {
    name: "settings",
    route: "settings",
    description: "The settings popover that opens from its button in the rail.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      const popover = page.locator(".settings-popover");
      await expect(popover).toBeVisible();
      await expect(popover.locator(".settings-head strong")).toHaveText("Interface settings");
      await expect(popover.getByText("Media and cache")).toBeVisible();
    },
  },
  {
    name: "ai-chat",
    route: "chats",
    description: "The AI chat panel, opened from the rail, with no service configured yet.",
    viewports: ["desktop", "narrow"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      await expect(page.locator(".thread-sidebar")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.locator(".app-rail").getByTitle("AI Chat").click();
      const panel = page.locator(".ai-page");
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Start a new conversation with the AI assistant.")).toBeVisible();
    },
  },
  {
    name: "account-menu",
    route: "chats",
    description: "The account popover at the top of the rail, with its connection rows and sign-out.",
    viewports: ["desktop"],
    setup: standardWorld,
    target: () => ({ account: ACCOUNT.id }),
    ready: async ({ page, expect }) => {
      await expect(page.locator(".thread-sidebar")).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.locator(".rail-avatar-button").click();
      const popover = page.locator(".account-popover");
      await expect(popover).toBeVisible();
      await expect(popover.getByText("Alex Morgan", { exact: true })).toBeVisible();
      await expect(popover.getByText("Sign out")).toBeVisible();
    },
  },
  {
    name: "desktop-hub-connect",
    route: "servers",
    description: "The desktop app's hub picker, shown when no hub has been connected yet.",
    viewports: ["desktop", "narrow"],
    setup: async () => ({}),
    prepare: ({ page }) => desktopBridge(page, { settings: LEFTOVER_HUB_SETTINGS }),
    target: () => ({}),
    ready: async ({ page, expect }) => {
      await expect(page.getByRole("heading", { name: "Welcome to AgentWechat" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use this device" })).toBeVisible();
    },
  },
  {
    name: "desktop-leftover-hub",
    route: "servers",
    description: "The desktop app's first screen when a hub left running by an earlier session holds the local port.",
    viewports: ["desktop", "narrow"],
    setup: async () => ({}),
    prepare: ({ page }) =>
      desktopBridge(page, {
        bootstrapError: LEFTOVER_HUB_SETTINGS.localHubError,
        settings: LEFTOVER_HUB_SETTINGS,
      }),
    target: () => ({}),
    ready: async ({ page, expect }) => {
      await expect(page.getByRole("heading", { name: "Welcome to AgentWechat" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop leftover hub" })).toBeVisible();
    },
  },
  {
    name: "desktop-settings",
    route: "servers",
    description: "Desktop settings, including whether this device's hub keeps running while another hub is used.",
    viewports: ["desktop", "narrow"],
    setup: async () => ({}),
    prepare: ({ page }) =>
      desktopBridge(page, {
        bootstrapError: LEFTOVER_HUB_SETTINGS.localHubError,
        settings: LEFTOVER_HUB_SETTINGS,
      }),
    target: () => ({}),
    ready: async ({ page, expect }) => {
      await expect(page.getByRole("heading", { name: "Welcome to AgentWechat" })).toBeVisible();
    },
    actions: async ({ page, expect }) => {
      await page.getByRole("button", { name: "Desktop settings" }).click();
      await expect(page.getByRole("heading", { name: "Desktop settings" })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: "Keep this device’s hub running" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop leftover hub" })).toBeVisible();
    },
  },
];
