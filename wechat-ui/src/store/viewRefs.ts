// Compatibility aliases for the imperative handles. The canonical registry
// lives in ./caches (the store actions call it); these names keep the
// component-facing API stable and add the in-conversation search input.

export type { ComposerHandle, MessageListHandle, SearchFocusHandle } from './caches'
export {
  handles as viewRefs,
  registerComposerHandle as registerComposerView,
  registerContactsPanelHandle as registerContactsPanelView,
  registerMessageListHandle as registerMessageListView,
  registerThreadListHandle as registerThreadListView,
  registerThreadSearchInput,
} from './caches'
