"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFocusNav } from "./useFocusNav";
import { isMenuNavSuspended } from "./useMenuNav";
import { useInputMode } from "./input-mode";
import { DeviceStep } from "./steps/DeviceStep";
import { KeyboardStep } from "./steps/KeyboardStep";
import { ControllerStep } from "./steps/ControllerStep";
import { WheelStep } from "./steps/WheelStep";
import { AssistsStep } from "./steps/AssistsStep";
import { CarStep } from "./steps/CarStep";
import type { SetupStepProps } from "./steps/types";
import { isTouchDevice } from "@/lib/input/touch-input";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { Button, SettingsDetailProvider } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { KeyCap, PadGlyph, PromptBar } from "@/components/ui/prompts";
import { cx } from "@/components/ui/styles";
import { SettingsEnvProvider, type SettingsEnv } from "@/components/settings/env";

export type WizardStepId = "device" | "setup" | "assists" | "car";
/** The first visit, or the same setup run again from Settings > Controls > Device */
export type WizardMode = "first-run" | "again";

const STEPS: readonly WizardStepId[] = ["device", "setup", "assists", "car"];

const SETUP_TITLES = { keyboard: "Keyboard", controller: "Controller", wheel: "Wheel and pedals" } as const;

const STEP_INFO: Record<Exclude<WizardStepId, "setup">, { title: string; detail: string }> = {
  device: { title: "How do you drive?", detail: "Pick your input. It can be changed any time in Settings." },
  assists: { title: "Driving assists", detail: "Pick a starting point. Every assist is in Settings, under Driving." },
  car: { title: "Your car", detail: "Choose a car and livery, then head for the grid." },
};

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
 * First-run setup (device, its setup, assists, car), also run again from Settings. Docked left so the car stays
 * visible on the right. Its rows are the Settings screen's own, shown at the Simple level.
 */
export const FirstRunWizard: React.FC<FirstRunWizardProps> = (props) => {
  const { mode, onFinish, onExit, onSkip, onStepChange } = props;
  // A touch screen offers its own controls first; driving by touch has no key setup to go through
  const [touchFirst] = useState(isTouchDevice);
  const [touchPicked, setTouchPicked] = useState(touchFirst);
  const steps = touchFirst && touchPicked ? STEPS.filter((s) => s !== "setup") : STEPS;
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
    bodyRef.current?.scrollTo({ top: 0 });
    // A new step starts on its marked first row (or its first control), never on a reset
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const el =
        body.querySelector<HTMLElement>("[data-nav-default]") ??
        body.querySelector<HTMLElement>("button:not([disabled]):not([data-card-reset]):not([data-nav-skip]), input:not([disabled])");
      el?.focus({ preventScroll: true });
    });
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
  const info =
    step === "setup"
      ? {
          title: SETUP_TITLES[device],
          detail:
            device === "wheel"
              ? "Calibrate steering and pedals, and map your paddles."
              : device === "controller"
                ? "Check your inputs and pick how the steering feels."
                : "Every key can be changed: press a key's slot, then the new key.",
        }
      : STEP_INFO[step];

  const stepTitle = (s: WizardStepId) => (s === "setup" ? SETUP_TITLES[device] : STEP_INFO[s].title);
  // The main column's width follows the step: the wheel's two columns get the most room, the car the least
  const mainWidth =
    step === "setup" && device === "wheel"
      ? "max-w-[1240px]"
      : step === "car"
        ? "max-w-[640px]"
        : "max-w-[800px]";

  return (
    <div
      ref={rootRef}
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-40 flex bg-linear-to-r from-lc-void/96 via-lc-void/88 to-lc-void/20"
    >
      <SettingsEnvProvider value={env}>
        <SettingsDetailProvider value="simple">
          <div className="flex h-full w-full flex-col pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.75rem,env(safe-area-inset-top))] short:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="flex min-h-0 flex-1 gap-10">
              {/* Step rail (roomy screens): where the player is in the setup */}
              <aside className="hidden w-56 shrink-0 flex-col gap-9 not-compact:flex">
                <LibreCorsaLogo variant="compact" size="sm" />
                <nav aria-label="Setup steps" className="flex flex-col">
                  {steps.map((s, i) => {
                    const done = i < stepIndex;
                    const current = i === stepIndex;
                    return (
                      <React.Fragment key={s}>
                        {i > 0 ? (
                          <span aria-hidden className={cx("ml-3.5 h-6 w-0.5 rounded-full", i <= stepIndex ? "bg-lc-fog" : "bg-lc-line")} />
                        ) : null}
                        <div aria-current={current ? "step" : undefined} className="flex min-h-11 items-center gap-3.5">
                          <span
                            className={cx(
                              "lc-mono inline-flex size-7.5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
                              current ? "bg-lc-chalk text-lc-void" : done ? "bg-lc-line text-lc-chalk" : "text-lc-slate inset-ring-2 inset-ring-lc-line",
                            )}
                          >
                            {done ? <Icon name="check" label="Done" /> : i + 1}
                          </span>
                          <span className={cx("text-[16px] leading-tight", current ? "font-semibold text-lc-chalk" : done ? "text-lc-fog" : "text-lc-slate")}>
                            {stepTitle(s)}
                          </span>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </nav>
              </aside>

              <div className={cx("flex min-w-0 flex-1 flex-col", mainWidth)}>
                <span className="not-compact:hidden">
                  <LibreCorsaLogo variant="compact" size="sm" className="hidden sm:inline-flex" />
                </span>
                <h1 className="lc-h1 mt-3 short:mt-1">{info.title}</h1>
                <p className="lc-body mt-2 text-[15px] short:hidden">{info.detail}</p>

                {/* Progress (phones and short windows, where the step rail is hidden) */}
                <div className="mt-4 flex items-center gap-1.5 not-compact:hidden short:mt-2" aria-hidden>
                  {steps.map((s, i) => (
                    <span
                      key={s}
                      className={cx("h-1.5 flex-1 rounded-full", i < stepIndex ? "bg-lc-fog" : i === stepIndex ? "bg-lc-chalk" : "bg-lc-line")}
                    />
                  ))}
                  <span className="lc-mono ml-1.5 shrink-0 text-[11px] text-lc-slate">
                    {stepIndex + 1} of {steps.length}
                  </span>
                </div>

                <div ref={bodyRef} className="-mx-1.5 mt-4 min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-2 not-compact:mt-6 short:mt-2">
                  {step === "device" ? (
                    <DeviceStep pickedRef={devicePickedRef} touch={touchFirst ? { picked: touchPicked, onPick: setTouchPicked } : null} />
                  ) : null}
                  {step === "setup" && device === "keyboard" ? <KeyboardStep /> : null}
                  {step === "setup" && device === "controller" ? <ControllerStep /> : null}
                  {step === "setup" && device === "wheel" ? <WheelStep /> : null}
                  {step === "assists" ? <AssistsStep /> : null}
                  {step === "car" ? <CarStep {...props} /> : null}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3.5 border-t border-lc-line pt-4 short:mt-2 short:pt-2">
              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={back} prompt={pad ? <PadGlyph button="b" family={family} /> : <KeyCap>Esc</KeyCap>}>
                  {stepIndex === 0 ? (mode === "first-run" ? "Main menu" : "Close") : "Back"}
                </Button>
                {onSkip && !last ? (
                  <Button variant="ghost" size="sm" onClick={onSkip}>
                    Skip and use defaults
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-5.5">
                <PromptBar
                  rule={false}
                  className="hidden sm:flex"
                  prompts={[
                    { action: "move", label: "Move" },
                    { action: "select", label: "Select" },
                    { action: "tabs", label: "Step" },
                  ]}
                />
                <Button variant="primary" onClick={next} prompt={pad ? <PadGlyph button="menu" family={family} /> : <KeyCap tone="ink">Enter</KeyCap>}>
                  {last ? (mode === "first-run" ? "Lights out" : "Done") : "Next"}
                </Button>
              </div>
            </div>
          </div>
        </SettingsDetailProvider>
      </SettingsEnvProvider>
    </div>
  );
};
