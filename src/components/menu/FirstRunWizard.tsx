"use client";

import React, { useEffect, useRef, useState } from "react";
import { useFocusNav } from "./useFocusNav";
import { PadGlyph, PrimaryButton, PromptBar } from "./menu-ui";
import { useInputMode } from "./input-mode";
import { DeviceStep } from "./steps/DeviceStep";
import { KeyboardStep } from "./steps/KeyboardStep";
import { ControllerStep } from "./steps/ControllerStep";
import { WheelStep } from "./steps/WheelStep";
import { AssistsStep } from "./steps/AssistsStep";
import { CarStep } from "./steps/CarStep";
import type { SetupStepProps } from "./steps/types";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

export type WizardStepId = "device" | "setup" | "assists" | "car";
export type WizardMode = "first-run" | "controls";

const STEPS: Record<WizardMode, readonly WizardStepId[]> = {
  "first-run": ["device", "setup", "assists", "car"],
  controls: ["device", "setup"],
};

const SETUP_TITLES = { keyboard: "Keyboard", controller: "Controller", wheel: "Wheel & pedals" } as const;

const STEP_INFO: Record<Exclude<WizardStepId, "setup">, { title: string; detail: string }> = {
  device: { title: "How do you drive?", detail: "Pick your input. You can change it any time from the menu." },
  assists: { title: "Driving assists", detail: "Pick a starting point; every switch stays in the pause menu." },
  car: { title: "Your car", detail: "Choose a car and livery, then head for the grid." },
};

export interface FirstRunWizardProps extends SetupStepProps {
  mode: WizardMode;
  /** Finished (first run: start driving; controls: return) */
  onFinish: () => void;
  /** Left via Back on the first step */
  onExit: () => void;
  /** Skip the rest with defaults (first run only) */
  onSkip?: () => void;
  onStepChange?: (step: WizardStepId) => void;
}

/**
 * First-run setup (device → device setup → assists → car) and the shorter controls setup reopened
 * from the menus. Docked left so the car stays visible on the right.
 */
export const FirstRunWizard: React.FC<FirstRunWizardProps> = (props) => {
  const { mode, onFinish, onExit, onSkip, onStepChange } = props;
  const steps = STEPS[mode];
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];
  const last = stepIndex === steps.length - 1;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { mode: inputMode, family } = useInputMode();
  const pad = inputMode === "pad";

  useEffect(() => {
    onStepChange?.(step);
    bodyRef.current?.scrollTo({ top: 0 });
    // A new step starts on its selected option (or its first control)
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const el =
        body.querySelector<HTMLElement>('[aria-pressed="true"], [aria-selected="true"], [data-nav-default]') ??
        body.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
      el?.focus({ preventScroll: true });
    });
  }, [step, onStepChange]);

  const next = () => (last ? onFinish() : setStepIndex((i) => i + 1));
  const back = () => (stepIndex === 0 ? onExit() : setStepIndex((i) => i - 1));

  // Ⓑ / Esc back, Menu next, LB / RB (Q / E) step back / next; Enter continues unless a control has focus
  useFocusNav(rootRef, { onBack: back, onStart: next, onPrevTab: back, onNextTab: next, autoFocus: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
      const el = document.activeElement;
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const info =
    step === "setup"
      ? {
          title: SETUP_TITLES[props.settings.device],
          detail:
            props.settings.device === "wheel"
              ? "Calibrate steering and pedals; map your paddles."
              : props.settings.device === "controller"
                ? "Check your inputs and pick how the steering feels."
                : "Every key can be rebound. Click a key, then press the new one.",
        }
      : STEP_INFO[step];

  return (
    <div ref={rootRef} className="pointer-events-auto fixed inset-0 z-40 flex bg-gradient-to-r from-[#08090D]/95 via-[#08090D]/82 to-[#08090D]/15 lg:via-[#08090D]/65 lg:to-transparent">
      <div className="flex h-full w-full max-w-3xl flex-col px-5 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-10 short:pt-3 short:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-f1-mono text-xs font-black tracking-[0.22em] text-[#CCFF00] uppercase">
            <span className="h-2 w-2 rounded-full bg-[#CCFF00]" />
            {mode === "first-run" ? "First-time setup" : "Controls"} · Step {stepIndex + 1} of {steps.length}
          </div>
          <LibreCorsaLogo variant="compact" className="hidden sm:inline-flex" />
        </div>
        <h1 className="mt-1 font-f1-italic text-3xl leading-none tracking-wide text-[#F5F7FA] uppercase sm:text-5xl short:text-2xl">
          {info.title}
        </h1>
        <p className="mt-2 font-f1-mono text-xs text-[#8E96AA] short:hidden">{info.detail}</p>

        {/* Progress rail */}
        <div className="mt-4 flex gap-1.5 short:mt-2">
          {steps.map((s, i) => (
            <span
              key={s}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i < stepIndex ? "bg-[#00E5FF]" : i === stepIndex ? "bg-[#CCFF00]" : "bg-[#262B3D]"
              }`}
            />
          ))}
        </div>

        <div ref={bodyRef} className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1 pb-2 short:mt-3">
          {step === "device" ? <DeviceStep {...props} autoDetect={mode === "first-run"} /> : null}
          {step === "setup" && props.settings.device === "keyboard" ? <KeyboardStep {...props} /> : null}
          {step === "setup" && props.settings.device === "controller" ? <ControllerStep {...props} /> : null}
          {step === "setup" && props.settings.device === "wheel" ? <WheelStep {...props} /> : null}
          {step === "assists" ? <AssistsStep {...props} /> : null}
          {step === "car" ? <CarStep {...props} /> : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D] pt-4 short:mt-2 short:pt-2">
          <div className="flex items-center gap-3">
            <PrimaryButton tone="dark" onClick={back} prompt={pad ? <PadGlyph button="b" family={family} /> : null}>
              {stepIndex === 0 ? (mode === "first-run" ? "Main menu" : "Close") : "Back"}
            </PrimaryButton>
            {onSkip && !last ? (
              <button
                type="button"
                onClick={onSkip}
                className="cursor-pointer font-f1-mono text-[11px] font-bold tracking-wide text-[#8E96AA] uppercase hover:text-[#CCFF00]"
              >
                Skip · use defaults
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <PromptBar
              className="hidden sm:flex"
              prompts={[
                { action: "move", label: "Move" },
                { action: "select", label: "Select" },
                { action: "tabs", label: "Step" },
              ]}
            />
            <PrimaryButton onClick={next} prompt={pad ? <PadGlyph button="menu" family={family} /> : null}>
              {last ? (mode === "first-run" ? "Lights out" : "Done") : "Next"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
};
