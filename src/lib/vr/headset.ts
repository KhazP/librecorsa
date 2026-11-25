import { isTouchDevice } from "@/lib/input/touch-input";

/**
 * A standalone headset's own browser: Meta Quest Browser ("OculusBrowser", "Quest 3"), Pico, Wolvic, Vision Pro aside
 * (Safari there reports as a Mac). Their browsers call themselves desktop Linux ("X11; Linux x86_64") with a fine
 * pointer, so the game took a Quest for a desktop: High graphics, 4x MSAA, uncompressed textures and the heaviest
 * sky, on a phone chip.
 */
const STANDALONE_HEADSET = /OculusBrowser|\bQuest\b|Pico ?Browser|PicoBrowser|\bPico\b|Wolvic|Mobile VR/i;

export function isStandaloneHeadset(ua: string | undefined = typeof navigator === "undefined" ? undefined : navigator.userAgent): boolean {
  return Boolean(ua && STANDALONE_HEADSET.test(ua));
}

/**
 * A phone-class GPU: a phone or tablet, or a standalone headset. The graphics choices made for phones (Medium by
 * default, automatic quality, no MSAA, compressed textures, the lighter reflection probe and sky) follow this rather
 * than the touch screen, which still decides the touch controls alone.
 */
export function mobileClassGpu(): boolean {
  return isTouchDevice() || isStandaloneHeadset();
}
