// English catalogue, split by interface area so each area can be edited on its
// own. Keys are the Chinese source strings used in the components.
import ai from './ai.json'
import app from './app.json'
import chat from './chat.json'
import common from './common.json'
import composer from './composer.json'
import contactSearch from './contact-search.json'
import contacts from './contacts.json'
import desktop from './desktop.json'
import login from './login.json'
import messages from './messages.json'
import rail from './rail.json'
import settings from './settings.json'
import voice from './voice.json'

const merged: Record<string, string> = {
  ...ai,
  ...app,
  ...chat,
  ...common,
  ...composer,
  ...contactSearch,
  ...contacts,
  ...desktop,
  ...login,
  ...messages,
  ...rail,
  ...settings,
  ...voice,
}

export default merged
