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
import { DriverStep } from "./steps/DriverStep";
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

export type WizardStepId = "device" | "setup" | "assists" | "hud" | "driver";
/** The first visit, or the same setup run again from Settings > Controls > Device */
export type WizardMode = "first-run" | "again";

/**
 * How the player drives, then what they see on the screen, then their driver profile and starting view before Lights out.
 */
const STEPS: readonly WizardStepId[] = ["device", "setup", "assists", "hud", "driver"];

export interface FirstRunWizardProps extends SetupStepProps {
  mode: WizardMode;
  /** The current car's steering lock (road-wheel degrees), for the countersteer sliders */
  steerLockDeg?: number;
  /** Claims a new driver name on the online board: null once taken, else why not */
  onRenameDriver?: (name: string) => Promise<string | null>;
  /** Marks the current generated driver name as confirmed when the player finishes the Driver step */
  onConfirmDriverName?: () => void;
  /** Finished (first run: start driving; again: return) */
  onFinish: () => void;
  /** Left via Back on the first step */
  onExit: () => void;
  /** Skip the rest with defaults (first run only) */
  onSkip?: () => void;
  onStepChange?: (step: WizardStepId) => void;
}

/**
 * First-run setup (device, its setup, assists, HUD, car), also run again from Settings. Full-height, centred shell
 * matching Settings and Career so the step rail, step body and footer stay aligned across every step.
 */
const isInteractiveControl = (el: Element | null): boolean =>
  el instanceof HTMLButtonElement ||
  el instanceof HTMLAnchorElement ||
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement;

/** An already-selected radio option (outside class tabs) where pressing Enter confirms the choice and continues */
const isConfirmRadio = (el: Element | null): boolean =>
  el instanceof HTMLButtonElement &&
  el.getAttribute("role") === "radio" &&
  el.getAttribute("aria-checked") === "true" &&
  !el.closest("[data-wizard-stay]");

export const FirstRunWizard: React.FC<FirstRunWizardProps> = (props) => {
  const { mode, onFinish, onExit, onSkip, onStepChange, onRenameDriver, onConfirmDriverName } = props;
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
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);
  const [enterAdvances, setEnterAdvances] = useState(true);
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
      onRenameDriver,
    }),
    [props.settings, props.onChangeSettings, props.gamepadRumble, props.onToggleGamepadRumble, props.steerLockDeg, props.carId, props.vehicleModel, onRenameDriver],
  );

  const syncEnterHint = () => {
    const el = document.activeElement;
    setEnterAdvances(el === nextBtnRef.current || isConfirmRadio(el) || !isInteractiveControl(el));
  };

  useEffect(() => {
    onStepChange?.(step);
    bodyRef.current?.scrollTo({ top: 0 });
    // Start on the step's marked default option; where a step has none (Keyboard, so Enter never traps the player in
    // key-rebinding), land on Next so Enter continues straight through and Up moves into the bindings.
    const raf = requestAnimationFrame(() => {
      const body = bodyRef.current;
      const el = body?.querySelector<HTMLElement>("[data-nav-default]") ?? nextBtnRef.current;
      el?.focus({ preventScroll: true });
      syncEnterHint();
    });
    return () => cancelAnimationFrame(raf);
  }, [step, onStepChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onChange = () => requestAnimationFrame(syncEnterHint);
    root.addEventListener("focusin", onChange);
    root.addEventListener("focusout", onChange);
    root.addEventListener("click", onChange);
    return () => {
      root.removeEventListener("focusin", onChange);
      root.removeEventListener("focusout", onChange);
      root.removeEventListener("click", onChange);
    };
  }, []);

  const finish = () => {
    if (step === "driver") onConfirmDriverName?.();
    onFinish();
  };
  const next = () => (last ? finish() : setStepIndex(stepIndex + 1));
  const back = () => (stepIndex === 0 ? onExit() : setStepIndex(stepIndex - 1));
  // Q / E and LB / RB move strictly between steps without accidentally exiting on step 1 or launching on the last step
  const prevStep = () => setStepIndex((i) => Math.max(0, i - 1));
  const nextStep = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));

  // B / Esc back, Menu next, LB / RB (Q / E) step back / next; Enter advances on confirmed choices or Next
  useFocusNav(rootRef, { onBack: back, onStart: next, onPrevTab: prevStep, onNextTab: nextStep, autoFocus: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // useFocusNav runs first and marks the keys it handled; like it, this stays out of a capture or calibration
      if (e.defaultPrevented || e.repeat || isMenuNavSuspended() || (e.code !== "Enter" && e.code !== "NumpadEnter")) return;
      const el = document.activeElement;
      // Next handles its own click via the native button
      if (el === nextBtnRef.current) return;
      if (isConfirmRadio(el) || !isInteractiveControl(el)) {
        e.preventDefault();
        next();
      }
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
    driver: tx("driver"),
  };
  const stepTitle = (s: WizardStepId) => (s === "setup" ? setupTitles[device] : stepTitles[s]);
  const title = stepTitle(step);

  return (
    <div
      ref={rootRef}
      className="lc-menu-screen lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-menu) flex bg-lc-void/88 backdrop-blur-md"
    >
      <SettingsEnvProvider value={env}>
        <SettingsDetailProvider value="simple">
          <div className="flex h-full w-full flex-col pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.75rem,env(safe-area-inset-top))] short:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {/* One full-height centred frame across every step so the step rail, content and bottom bar never jump */}
            <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col">
              <div className="flex min-h-0 flex-1 gap-8 lg:gap-10">
                {/* Step rail (roomy screens): clickable motorsport step index */}
                <aside className="hidden w-52 shrink-0 flex-col gap-8 not-compact:flex">
                  <LibreCorsaLogo variant="compact" size="sm" />
                  <nav aria-label={tx("steps")} className="flex flex-col gap-1">
                    {steps.map((s, i) => {
                      const done = i < stepIndex;
                      const current = i === stepIndex;
                      return (
                        <button
                          key={s}
                          type="button"
                          data-nav-skip=""
                          aria-current={current ? "step" : undefined}
                          onClick={() => setStepIndex(i)}
                          className={cx(
                            "flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-lc-row border-0 border-s-2 px-3 text-start transition-colors",
                            current
                              ? "border-lc-volt bg-lc-volt/8"
                              : done
                                ? "border-lc-fog/50 bg-transparent hover:bg-white/4"
                                : "border-lc-line bg-transparent hover:bg-white/4",
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
                        </button>
                      );
                    })}
                  </nav>
                </aside>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                    className="-mx-1.5 mt-4 min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-2 not-compact:mt-6 short:mt-2"
                  >
                    {step === "device" ? (
                      <DeviceStep pickedRef={devicePickedRef} touch={touchFirst ? { picked: touchPicked, onPick: setTouchPicked } : null} />
                    ) : null}
                    {step === "setup" && device === "keyboard" ? <KeyboardStep /> : null}
                    {step === "setup" && device === "controller" ? <ControllerStep /> : null}
                    {step === "setup" && device === "wheel" ? <WheelStep /> : null}
                    {step === "assists" ? <AssistsStep /> : null}
                    {step === "hud" ? <HudStep /> : null}
                    {step === "driver" ? (
                      <DriverStep
                        onNameCommitted={() => {
                          nextBtnRef.current?.focus({ preventScroll: true });
                          syncEnterHint();
                        }}
                      />
                    ) : null}
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
                  <Button
                    ref={nextBtnRef}
                    variant="primary"
                    onClick={next}
                    prompt={pad ? <PadGlyph button="menu" family={family} /> : enterAdvances ? <KeyCap tone="ink">Enter</KeyCap> : undefined}
                  >
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
