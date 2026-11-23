/**
 * The English messages, the source every other language is translated from. One file per area of the game, so each
 * area's strings sit together and two people (or agents) working on different areas never edit the same file:
 *
 *   common     words used across the game (OK, Back, Close, On, Off when they mean the same thing everywhere)
 *   menu       the title menu, the pause menu and the panels they open
 *   settings   the Settings screen: every row's label, hint and choices
 *   setup      first-run setup and the device steps (wheel, controller, DualSense, touch)
 *   hud        the driving HUD, its notices and the lap and race screens
 *   hudStyles  the HUD layouts' own labels
 *   home       the home page (librecorsa.org)
 *   board      the lap boards, the Hall of Fame and badges
 *   game       messages the simulation and its systems raise (track limits, penalties, connection, loading)
 *
 * A new area gets its own file here, in every language's folder (npm run i18n:add makes them) and in src/i18n/notes.
 */
import board from "./board.json";
import common from "./common.json";
import game from "./game.json";
import home from "./home.json";
import hud from "./hud.json";
import hudStyles from "./hudStyles.json";
import menu from "./menu.json";
import settings from "./settings.json";
import setup from "./setup.json";

const en = { common, menu, settings, setup, hud, hudStyles, home, board, game };

export default en;
