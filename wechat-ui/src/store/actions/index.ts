// Public action and selector surface. Components import everything from here.

// ---- Engine / lifecycle ---------------------------------------------------

/** Starts the interface (bootstrap, stream, timers, layout detection); returns the disposer. */
export { startEngine } from '../engine'
/** Stops the stream, timers and listeners; called when the shell unmounts. */
export { disposeEngine } from '../engine'
/** Opens or closes the event stream (also driven by the engine). */
export { startStream, stopStream } from '../engine'
/** Applies one daemon event to the store. */
export { handleStreamEvent } from '../engine'
/** Keeps the document title in sync with the account and open conversation. */
export { syncDocumentTitle } from '../engine'

// ---- Session --------------------------------------------------------------

/** Restores the session, paints cached data and opens either the chat or the login screen. */
export { bootstrap } from './session'
/** Re-reads the current account slot (header refresh button). */
export { refreshAccount } from './session'
/** Reloads every account slot for the login screen. */
export { refreshAccountSlots } from './session'
/** Starts a QR sign-in; the daemon creates a temporary slot and adopts an existing one. */
export { startLogin } from './session'
/** Cancels the running sign-in attempt. */
export { cancelLogin } from './session'
/** Regenerates the login QR image. */
export { retryQr } from './session'
/** Sets the QR image failure flag (the image element reports decode errors). */
export { setQrFailed } from './session'
/** Replaces the QR object URL, revoking the previous one. */
export { setQrObjectUrl } from './session'
/** Fetches the QR image bytes for the current attempt. */
export { loadQrImage } from './session'
/** Reloads the QR image when the account, attempt or generation changed. */
export { syncLoginQrForAttempt } from './session'
/** Signs the account out on the daemon and clears the interface. */
export { logoutAccount } from './session'
/** Turns the daemon offline mode on or off. */
export { toggleOfflineMode } from './session'
/** Clears the account action banner (its close button). */
export { clearAccountActionError } from './session'
/** Reads the WeChat nickname of the signed-in account. */
export { loadSelfProfile } from './session'
/** Asks the daemon to sync contacts and group profiles. */
export { startCatalogSync } from './session'
/** Continues after a successful sign-in. */
export { afterAuthenticated } from './session'
/** Resets the interface after the account signed out. */
export { handleSignedOut } from './session'
/** Schedules the next account poll. */
export { scheduleAccountPoll } from './session'
/** Polls the account slot and reacts to sign-in, sign-out and reconnect. */
export { pollAccount } from './session'
/** Starts polling the pending friend-request badge. */
export { startFriendRequestPoll } from './session'
/** Stops the friend-request poll and clears the badge. */
export { stopFriendRequestPoll } from './session'
/** Refreshes the pending friend-request badge once. */
export { refreshFriendRequestCount } from './session'
/** Resolves after the given number of milliseconds. */
export { sleep } from './session'
/** Turns an API failure into a short sentence the interface can show. */
export { errorText } from './session'
/** True when the slot is online or has saved login material. */
export { isSignedIn } from './session'
/** Connection tone ('online' | 'pending' | 'offline') of the current account. */
export { selectConnectionState } from './session'
/** Human label of the live event stream. */
export { selectStreamLabel } from './session'

// ---- Conversations --------------------------------------------------------

/** Reloads the conversation list (concurrent calls are collapsed). */
export { loadThreads } from './threads'
/** Opens a conversation, painting cached messages before refreshing. */
export { selectThread } from './threads'
/** Opens the contact search dialog for a new conversation. */
export { openNewChat } from './threads'
/** Starts (or opens) a conversation with a directory contact. */
export { startChatWithContact } from './threads'
/** Starts (or opens) a conversation by username or id. */
export { startChatWithId } from './threads'
/** Opens an existing conversation or creates a local draft conversation. */
export { startDraftChat } from './threads'
/** Marks every conversation read locally and syncs the daemon in the background. */
export { markAllThreadsRead } from './threads'
/** Marks the open conversation read from the details panel. */
export { markActiveThreadRead } from './threads'
/** Reports one conversation as read and stamps the local read cursor. */
export { markThreadRead } from './threads'
/** Returns to the conversation list on narrow layouts. */
export { goBackToList } from './threads'
/** Focuses the search field of the visible side panel. */
export { focusThreadSearch } from './threads'
/** Applies the narrow (phone) layout flag. */
export { setNarrow } from './threads'
/** Sets the conversation list filter query. */
export { setThreadQuery } from './threads'
/** Sets the conversation list filter tab. */
export { setFilterMode } from './threads'
/** Opens or closes the conversation details panel. */
export { setDetailsOpen } from './threads'
/** Toggles the conversation details panel. */
export { toggleDetails } from './threads'
/** Loads the contact profile shown in the details panel. */
export { loadContactProfile } from './threads'
/** Drops the loaded contact profile. */
export { resetContactProfile } from './threads'
/** Loads the full contact directory (throttled unless forced). */
export { loadContactDirectory } from './threads'
/** Fetches the authoritative profile of one contact when a chat opens. */
export { refreshContactAuthoritative } from './threads'
/** Overrides raw conversation titles with local directory names. */
export { applyContactNames } from './threads'
/** Schedules one conversation list refresh. */
export { scheduleThreadRefresh } from './threads'
/** Warms the message windows of the recent conversations in the background. */
export { warmRecentThreads } from './threads'
/** Persists the read cursors for the current account. */
export { persistReadCursor } from './threads'
/** Restores the read cursors written by an earlier page load. */
export { loadReadCursor } from './threads'
/** Records one conversation read cursor. */
export { stampThreadRead } from './threads'
/** Suppresses a backfilled unread count that predates a read cursor. */
export { suppressReadCursor } from './threads'
/** Clears the unread state of every conversation on the daemon. */
export { syncAllThreadsReadToDaemon } from './threads'
/** Notifies subscribers after a thread object was mutated in place. */
export { touchThreads } from './threads'
/** The conversation that is currently open. */
export { selectActiveThread } from './threads'
/** True when narrow layouts show the conversation pane instead of the list. */
export { selectMobileChatOpen } from './threads'
/** Unread badge total; muted and official conversations are excluded. */
export { selectUnreadTotal } from './threads'
/** True when the open conversation is a WeChat group. */
export { selectActiveThreadIsGroup } from './threads'
/** True when the open conversation is an official account (gh_). */
export { selectActiveThreadIsOfficial } from './threads'
/** Peer username shown in the conversation details. */
export { selectDetailsPeerId } from './threads'
/** Display name of the peer in the details panel. */
export { selectContactProfileName } from './threads'
/** Brand service account usernames from the directory. */
export { selectBusinessUsernames } from './threads'
/** True when the direct-message peer is not a confirmed friend yet. */
export { selectPeerIsStranger } from './threads'

// ---- Messages -------------------------------------------------------------

/** Loads one page of a conversation: reset, refresh or older. */
export { fetchThreadMessages } from './messages'
/** Merges server messages into the open window without duplicating echoes. */
export { mergeServerMessages } from './messages'
/** Schedules one refresh of the open conversation. */
export { scheduleMessageRefresh } from './messages'
/** Manual refresh of the open conversation and the thread list. */
export { refreshActiveMessages } from './messages'
/** Loads the previous page of the open conversation. */
export { loadOlderMessages } from './messages'
/** Called when the list scrolled back to the bottom. */
export { handleMessageListBottom } from './messages'
/** Scrolls the list to the newest message and clears the new-message pill. */
export { jumpToLatestMessage } from './messages'
/** Opens or closes the in-conversation search panel. */
export { toggleThreadSearch } from './messages'
/** Sets the in-conversation search query and schedules the search. */
export { setThreadSearchQuery } from './messages'
/** Searches the open conversation locally first, then across the daemon. */
export { runThreadSearch } from './messages'
/** Scrolls to a search hit, loading older pages until it is in the window. */
export { jumpToSearchResult } from './messages'
/** Display name of a search hit's sender. */
export { threadSearchSender } from './messages'
/** One-line preview of a search hit. */
export { threadSearchSnippet } from './messages'
/** Quotes a message in the composer. */
export { startReply } from './messages'
/** Drops the quoted message. */
export { cancelReply } from './messages'
/** Sender name and preview of the quoted message. */
export { selectReplyToDisplay } from './messages'
/** Updates the composer draft. */
export { setDraft } from './messages'
/** Classifies a picked file by MIME type and extension. */
export { detectMediaKind } from './messages'
/** Upload ceiling for one attachment kind. */
export { mediaLimit } from './messages'
/** Stages picked files for the next send. */
export { stageFiles } from './messages'
/** Removes one staged attachment. */
export { removeAttachment } from './messages'
/** Revokes every staged attachment preview. */
export { clearStagedAttachments } from './messages'
/** Revokes every object URL created for local media bubbles. */
export { revokeAllLocalMedia } from './messages'
/** Builds the daemon mention payload from the draft text. */
export { buildMentions } from './messages'
/** Loads and caches the member list of a group conversation. */
export { ensureGroupMembers } from './messages'
/** Mention picker entries for the open group conversation. */
export { selectMentionOptions } from './messages'
/** True while the member list of the open group is still loading. */
export { selectMentionLoading } from './messages'
/** Sends the draft text and every staged attachment. */
export { sendMessage } from './messages'
/** Message type, app type and fallback body of an outgoing attachment. */
export { localMediaType } from './messages'
/** Paints the cached conversation list and message windows at startup. */
export { loadCachedSessionData } from './messages'
/** Persists the conversation list, contact names and message windows. */
export { persistSessionData } from './messages'
/** Remembers the current message window for a conversation. */
export { cacheThreadMessages } from './messages'
/** Drops the persisted caches when a different account signs in. */
export { ensureCacheAccountMatch } from './messages'
/** Server messages only: optimistic bubbles and blob URLs never hit storage. */
export { persistableMessages } from './messages'

// ---- Media ----------------------------------------------------------------

/** Stores the media state of one message. */
export { setMessageMedia } from './media'
/** Collapses the asset states of one message into the state its bubble shows. */
export { resolveMediaState } from './media'
/** Turns a lookup error payload into a short message. */
export { mediaErrorText } from './media'
/** Revokes an object URL and forgets it. */
export { revokeUrl } from './media'
/** Asks the daemon to start one media transfer. */
export { requestTransferOnce } from './media'
/** Schedules one retry round for messages whose media is still pending. */
export { scheduleMediaRetry } from './media'
/** Re-looks up pending media, bounded by the per-message retry budget. */
export { retryPendingMedia } from './media'
/** Looks up the media state of one batch of messages. */
export { lookupMediaBatch } from './media'
/** Looks up media for the messages that do not have a state yet. */
export { loadMediaForMessages } from './media'
/** Drops every media state and retry guard. */
export { clearMessageMedia } from './media'
/** True when the message carries media the daemon serves on demand. */
export { isMediaMessage } from './media'
/** Number of media lookups issued per batch. */
export { MEDIA_BATCH_SIZE, MEDIA_BATCH_DELAY, MEDIA_MAX_RETRIES, MEDIA_RETRY_DELAY } from './media'

// ---- Interface ------------------------------------------------------------

/** Theme presets (label is translated lazily). */
export { UI_THEMES } from './ui'
/** Restores persisted appearance settings into the store and applies them. */
export { initializeUiSettings } from './ui'
/** Reads the persisted appearance settings. */
export { loadUiSettings } from './ui'
/** Writes the theme variables onto the document root. */
export { applyUiSettings } from './ui'
/** Persists the appearance settings to localStorage. */
export { persistUiSettings } from './ui'
/** Selects the accent theme. */
export { setThemeId } from './ui'
/** Switches between the dark and light theme. */
export { setThemeMode } from './ui'
/** Sets the message bubble font size. */
export { setBubbleFontSize } from './ui'
/** Sets the incoming bubble color ('' = follow the theme). */
export { setBubbleInColor } from './ui'
/** Sets the outgoing bubble color ('' = follow the theme). */
export { setBubbleOutColor } from './ui'
/** Sets how long an incoming toast stays on screen. */
export { setToastDurationMs } from './ui'
/** Enables or disables incoming message toasts. */
export { setToastEnabled } from './ui'
/** Selects the rail view (chats, contacts, friend requests or AI). */
export { setRailView } from './ui'
/** Opens the contact detail card for one saved contact. */
export { openContactEditor } from './ui'
/** Closes the contact detail card. */
export { closeContactEditor } from './ui'
/** Opens the image lightbox at the given source; null closes it. */
export { setLightboxSrc } from './ui'
/** Closes the image lightbox. */
export { closeLightbox } from './ui'
/** Removes one incoming toast card. */
export { dismissToast } from './ui'
/** Opens the conversation a toast card points at. */
export { openToast } from './ui'
/** Pushes a toast card for a conversation with a recent unread message. */
export { pushIncomingToast } from './ui'
/** Delays a toast card until the list refresh carries the new preview. */
export { scheduleIncomingToast } from './ui'
/** Opens or closes the contact search dialog. */
export { setContactDialogOpen } from './ui'
/** Opens or closes the settings popover. */
export { setSettingsOpen } from './ui'
/** Clears every toast timer. */
export { clearToastTimers } from './ui'
/** Maximum number of toast cards stacked at once. */
export { TOAST_LIMIT } from './ui'
/** Default time an incoming toast stays on screen. */
export { DEFAULT_TOAST_DURATION } from './ui'
/** Default message bubble font size. */
export { DEFAULT_BUBBLE_FONT_SIZE } from './ui'
/** localStorage key of the appearance settings. */
export { UI_SETTINGS_KEY } from './ui'

// ---- Component handles ----------------------------------------------------

/** Registers the message list handle used for scrolling. */
export { registerMessageListHandle } from '../caches'
/** Registers the composer handle used for focusing. */
export { registerComposerHandle } from '../caches'
/** Registers the thread list handle used for focusing its search field. */
export { registerThreadListHandle } from '../caches'
/** Registers the contacts panel handle used for focusing its search field. */
export { registerContactsPanelHandle } from '../caches'
/** Registers the in-conversation search input element. */
export { registerThreadSearchInput } from '../caches'
/** Imperative handle shapes the components implement. */
export type { ComposerHandle, MessageListHandle, SearchFocusHandle } from '../caches'

// ---- Shared constants -----------------------------------------------------

/** Conversation page size used by the thread list endpoint. */
export { PAGE_SIZE, MESSAGE_PAGE_SIZE } from '../caches'
/** Upload ceilings for attachments. */
export { MAX_IMAGE_VOICE_BYTES, MAX_VIDEO_FILE_BYTES } from '../caches'
/** localStorage key of the persisted session snapshot. */
export { UI_CACHE_KEY } from './messages'
/** localStorage key of the per-conversation read cursors. */
export { READ_CURSOR_KEY } from './threads'
/** localStorage key of the contact directory snapshot. */
export { DIRECTORY_CACHE_KEY } from './threads'
/** localStorage key of the last used account slot. */
export { LAST_ACCOUNT_KEY } from './session'
/** Prefix of the temporary slot a scan login creates. */
export { PENDING_LOGIN_PREFIX } from './session'
/** localStorage key of the login attempt idempotency key. */
export { LOGIN_ATTEMPT_STORAGE_KEY } from './session'
