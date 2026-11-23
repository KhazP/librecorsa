"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { useFocusNav } from "./useFocusNav";
import { isMenuNavSuspended } from "./useMenuNav";
import { useInputMode } from "./input-mode";
import { DeviceStep } from "./steps/DeviceStep";
import { KeyboardStep } from "./steps/KeyboardStep";
import { ControllerStep } from "./steps/ControllerStep";
import { WheelStep } from "./steps/WheelStep";
import { AssistsStep } from "./steps/AssistsStep";
import { CarStep } from "./steps/CarStep";
import { HudStep } from "./steps/HudStep";
import { usePhoneLayout } from "@/components/hud/styles/PhoneHud";
import type { SetupStepProps } from "./steps/types";
import { isTouchDevice } from "@/lib/input/touch-input";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { Button, SettingsDetailProvider } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { KeyCap, PadGlyph, PromptBar } from "@/components/ui/prompts";
import { cx } from "@/components/ui/styles";
import { SettingsEnvProvider, type SettingsEnv } from "@/components/settings/env";

export type WizardStepId = "device" | "setup" | "assists" | "hud" | "car";
/** The first visit, or the same setup run again from Settings > Controls > Device */
export type WizardMode = "first-run" | "again";

/**
 * How the player drives, then what they see on the screen, then the car and the grid. The HUD step comes after the
 * assists (both shape the drive) and before the car, whose step ends on Lights out with the car on the turntable.
 */
const STEPS: readonly WizardStepId[] = ["device", "setup", "assists", "hud", "car"];

export interface FirstRunWizardProps extends SetupStepProps {
  mode: WizardMode;
  /** The current car's steering lock (road-wheel degrees), for the countersteer sliders */
  steerLockDeg?: number;
  /** Finished (first run: start driving; again: return) */
  onFinish: () => void;
  /** Left via Back on the first step */
  onExit: () => void;
  /** Skip the rest with defaults (first run only) */
  onSkip?: () => void;
  onStepChange?: (step: WizardStepId) => void;
}

/**
 * First-run setup (device, its setup, assists, HUD, car), also run again from Settings. Docked left so the car stays
 * visible on the right. Its rows are the Settings screen's own, shown at the Simple level.
 */
export const FirstRunWizard: React.FC<FirstRunWizardProps> = (props) => {
  const { mode, onFinish, onExit, onSkip, onStepChange } = props;
  // A touch screen offers its own controls first; driving by touch has no key setup to go through
  const [touchFirst] = useState(isTouchDevice);
  const [touchPicked, setTouchPicked] = useState(touchFirst);
  // A phone-sized screen always drives with the Phone HUD, so the layout would change nothing there
  const phoneScreen = usePhoneLayout();
  const steps = STEPS.filter((s) => !(s === "setup" && touchFirst && touchPicked) && !(s === "hud" && phoneScreen));
  const [rawStepIndex, setStepIndex] = useState(0);
  // Clamped: the list can get shorter while open (touch picked), and must not run past its end
  const stepIndex = Math.min(rawStepIndex, steps.length - 1);
  const step = steps[stepIndex];
  const last = stepIndex === steps.length - 1;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The player chose a device on the first step: auto-detect must not override it when they come back to it */
  const devicePickedRef = useRef(mode === "again");
  const { mode: inputMode, family } = useInputMode();
  const pad = inputMode === "pad";
  const tx = useTranslations("menu.wizard");

  const env: SettingsEnv = useMemo(
    () => ({
      settings: props.settings,
      update: props.onChangeSettings,
      rumble: props.gamepadRumble,
      onToggleRumble: props.onToggleGamepadRumble,
      steerLockDeg: props.steerLockDeg,
      carId: props.carId,
      vehicleModel: props.vehicleModel,
    }),
    [props.settings, props.onChangeSettings, props.gamepadRumble, props.onToggleGamepadRumble, props.steerLockDeg, props.carId, props.vehicleModel],
  );

  useEffect(() => {
    onStepChange?.(step);
    const stepBody = bodyRef.current;
    stepBody?.scrollTo({ top: 0 });
    // On roomy screens Next follows a short step's content, so the next step's controls can come up under the pointer:
    // a quick second click must not unbind a key or move a slider there. Keys and pads are not affected.
    if (stepBody) stepBody.style.pointerEvents = "none";
    const settle = window.setTimeout(() => {
      if (stepBody) stepBody.style.pointerEvents = "";
    }, 400);
    // A new step starts on its marked first row (or its first control), never on a reset
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const el =
        body.querySelector<HTMLElement>("[data-nav-default]") ??
        body.querySelector<HTMLElement>("button:not([disabled]):not([data-card-reset]):not([data-nav-skip]), input:not([disabled])");
      el?.focus({ preventScroll: true });
    });
    return () => {
      window.clearTimeout(settle);
      if (stepBody) stepBody.style.pointerEvents = "";
    };
  }, [step, onStepChange]);

  const next = () => (last ? onFinish() : setStepIndex(stepIndex + 1));
  const back = () => (stepIndex === 0 ? onExit() : setStepIndex(stepIndex - 1));

  // B / Esc back, Menu next, LB / RB (Q / E) step back / next; Enter continues unless a control has focus
  useFocusNav(rootRef, { onBack: back, onStart: next, onPrevTab: back, onNextTab: next, autoFocus: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // useFocusNav runs first and marks the keys it handled; like it, this stays out of a capture or calibration
      if (e.defaultPrevented || isMenuNavSuspended() || (e.code !== "Enter" && e.code !== "NumpadEnter")) return;
      // Controls that take Enter themselves (buttons, links, fields), as useFocusNav leaves them
      const el = document.activeElement;
      if (
        el instanceof HTMLButtonElement ||
        el instanceof HTMLAnchorElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        return;
      e.preventDefault();
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const device = props.settings.device;
  const setupTitles = { keyboard: tx("keyboard"), controller: tx("controller"), wheel: tx("wheel") };
  const stepTitles: Record<Exclude<WizardStepId, "setup">, string> = {
    device: tx("device"),
    assists: tx("assists"),
    hud: tx("hud"),
    car: tx("car"),
  };
  const stepTitle = (s: WizardStepId) => (s === "setup" ? setupTitles[device] : stepTitles[s]);
  const title = stepTitle(step);
  // The step's width: the wheel's two columns get the most room, the car the least (it turns on the right). The
  // frame around the rail, the step and its actions is as wide as they are (rail 208 + gap 40 on roomy screens), so
  // Next ends where the step does, not in the far corner, and the scene keeps the rest of the screen. Its least is
  // 800 px, about what the actions row needs on one line (where it doesn't fit, Next wraps under Back, still right).
  const { main: mainWidth, frame: frameWidth } =
    step === "setup" && device === "wheel"
      ? { main: "max-w-[1240px]", frame: "max-w-[1240px] not-compact:max-w-[1488px]" }
      : step === "setup" && device === "keyboard"
        ? // Room for the key table's two columns with their labels on one line
          { main: "max-w-[880px]", frame: "max-w-[880px] not-compact:max-w-[1128px]" }
        : step === "hud"
          ? { main: "max-w-[1040px]", frame: "max-w-[1040px] not-compact:max-w-[1288px]" }
          : step === "car"
            ? { main: "max-w-[640px]", frame: "max-w-[800px] not-compact:max-w-[888px]" }
            : { main: "max-w-[800px]", frame: "max-w-[800px] not-compact:max-w-[1048px]" };

  return (
    <div
      ref={rootRef}
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-40 flex bg-linear-to-r from-lc-void/96 via-lc-void/88 to-lc-void/20"
    >
      <SettingsEnvProvider value={env}>
        <SettingsDetailProvider value="simple">
          <div className="flex h-full w-full flex-col pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.75rem,env(safe-area-inset-top))] short:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {/* One frame: the rail, the step and its actions. On roomy screens the step is as tall as its content and the
                actions follow it, so a short step reads as one block over the scene; a long one scrolls in its body
                with the actions kept on screen. Compact screens keep the actions at the foot, under the thumb. */}
            <div className={cx("flex min-h-0 w-full flex-1 flex-col", frameWidth)}>
              <div className="flex min-h-0 flex-1 gap-10 not-compact:flex-initial">
                {/* Step rail (roomy screens): motorsport step index */}
                <aside className="hidden w-52 shrink-0 flex-col gap-8 not-compact:flex">
                  <LibreCorsaLogo variant="compact" size="sm" />
                  <nav aria-label={tx("steps")} className="flex flex-col gap-1">
                    {steps.map((s, i) => {
                      const done = i < stepIndex;
                      const current = i === stepIndex;
                      return (
                        <div
                          key={s}
                          aria-current={current ? "step" : undefined}
                          className={cx(
                            "flex min-h-10 items-center gap-3 rounded-lc-row border-s-2 px-3",
                            current ? "border-lc-volt bg-lc-volt/8" : done ? "border-lc-fog/50" : "border-lc-line",
                          )}
                        >
                          <span
                            className={cx(
                              "lc-mono w-5 shrink-0 text-[12px] font-bold",
                              current ? "text-lc-volt" : done ? "text-lc-fog" : "text-lc-dim",
                            )}
                          >
                            {done ? <Icon name="check" size="xs" label={tx("stepDone")} /> : `0${i + 1}`}
                          </span>
                          <span className={cx("lc-title text-[14px] leading-tight", current ? "text-lc-chalk" : done ? "text-lc-fog" : "text-lc-slate")}>
                            {stepTitle(s)}
                          </span>
                        </div>
                      );
                    })}
                  </nav>
                </aside>

                <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col", mainWidth)}>
                  <span className="not-compact:hidden">
                    <LibreCorsaLogo variant="compact" size="sm" className="hidden sm:inline-flex" />
                  </span>
                  <h1 className="lc-h1 mt-3 short:mt-1">{title}</h1>

                  {/* Progress (phones and short windows, where the step rail is hidden) */}
                  <div className="mt-3 flex items-center gap-1.5 not-compact:hidden short:mt-2" aria-hidden>
                    {steps.map((s, i) => (
                      <span
                        key={s}
                        className={cx("h-1 flex-1 rounded-lc-nub", i < stepIndex ? "bg-lc-fog" : i === stepIndex ? "bg-lc-volt" : "bg-lc-line")}
                      />
                    ))}
                    <span className="lc-mono ms-1.5 shrink-0 text-[11px] text-lc-slate">
                      {stepIndex + 1}/{steps.length}
                    </span>
                  </div>

                  <div
                    ref={bodyRef}
                    className="-mx-1.5 mt-4 min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-2 not-compact:mt-6 not-compact:flex-auto short:mt-2"
                  >
                    {step === "device" ? (
                      <DeviceStep pickedRef={devicePickedRef} touch={touchFirst ? { picked: touchPicked, onPick: setTouchPicked } : null} />
                    ) : null}
                    {step === "setup" && device === "keyboard" ? <KeyboardStep /> : null}
                    {step === "setup" && device === "controller" ? <ControllerStep /> : null}
                    {step === "setup" && device === "wheel" ? <WheelStep /> : null}
                    {step === "assists" ? <AssistsStep /> : null}
                    {step === "hud" ? <HudStep /> : null}
                    {step === "car" ? <CarStep {...props} /> : null}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3.5 border-t border-lc-line pt-4 short:mt-2 short:pt-2">
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={back} prompt={pad ? <PadGlyph button="b" family={family} /> : <KeyCap>Esc</KeyCap>}>
                    {stepIndex === 0 ? (mode === "first-run" ? tx("mainMenu") : tx("close")) : tx("back")}
                  </Button>
                  {onSkip && !last ? (
                    <Button variant="ghost" size="sm" onClick={onSkip}>
                      {tx("skip")}
                    </Button>
                  ) : null}
                </div>
                {/* Right-aligned even when a narrow frame wraps it under Back */}
                <div className="ms-auto flex flex-wrap items-center justify-end gap-5.5">
                  <PromptBar
                    rule={false}
                    className="hidden sm:flex"
                    prompts={[
                      { action: "move", label: tx("promptMove") },
                      { action: "select", label: tx("promptSelect") },
                      { action: "tabs", label: tx("promptStep") },
                    ]}
                  />
                  <Button variant="primary" onClick={next} prompt={pad ? <PadGlyph button="menu" family={family} /> : <KeyCap tone="ink">Enter</KeyCap>}>
                    {last ? (mode === "first-run" ? tx("lightsOut") : tx("done")) : tx("next")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </SettingsDetailProvider>
      </SettingsEnvProvider>
    </div>
  );
};
