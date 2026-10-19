"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
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

  const stepTitle = (s: WizardStepId) => (s === "setup" ? SETUP_TITLES[props.settings.device] : STEP_INFO[s].title);
  // The main column's width follows the boards: the wheel's two columns get the most room, the car the least
  const mainWidth =
    step === "setup" && props.settings.device === "wheel"
      ? "max-w-[980px]"
      : step === "car"
        ? "max-w-[640px]"
        : step === "setup" || step === "assists"
          ? "max-w-[800px]"
          : "max-w-[760px]";

  return (
    <div
      ref={rootRef}
      className={`pointer-events-auto fixed inset-0 z-40 flex bg-gradient-to-r from-[#08090D]/95 via-[#08090D]/82 to-[#08090D]/15 ${
        step === "car"
          ? "not-compact:bg-[linear-gradient(90deg,rgba(8,9,13,0.97)_0%,rgba(8,9,13,0.88)_45%,rgba(8,9,13,0)_68%)]"
          : "not-compact:bg-[linear-gradient(90deg,rgba(8,9,13,0.97)_0%,rgba(8,9,13,0.9)_55%,rgba(8,9,13,0.15)_80%)]"
      }`}
    >
      <div className="flex h-full w-full flex-col px-5 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-10 lg:px-[clamp(20px,3.9vw,56px)] short:pt-3 short:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 gap-[clamp(24px,3.4vw,48px)]">
          {/* Step rail (roomy screens): where you are in the setup */}
          <aside className="hidden w-[230px] shrink-0 flex-col gap-9 not-compact:flex">
            <LibreCorsaLogo variant="compact" size="sm" />
            <nav aria-label="Setup steps" className="flex flex-col">
              <span className="lc-lbl mb-3.5">{mode === "first-run" ? "First-time setup" : "Controls"}</span>
              {steps.map((s, i) => {
                const done = i < stepIndex;
                const current = i === stepIndex;
                return (
                  <React.Fragment key={s}>
                    {i > 0 ? (
                      <span
                        aria-hidden
                        className={`ml-3.5 h-[26px] w-0.5 rounded-sm transition-colors duration-200 ${
                          i <= stepIndex ? "bg-[#00E5FF]" : "bg-[#262B3D]"
                        }`}
                      />
                    ) : null}
                    <div aria-current={current ? "step" : undefined} className="flex min-h-[44px] items-center gap-3.5">
                      <span
                        className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full font-f1-mono text-[12px] font-extrabold ${
                          current
                            ? "bg-[#CCFF00] text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.15)]"
                            : done
                              ? "bg-[#00E5FF] text-[#08090D]"
                              : "border-2 border-[#262B3D] text-[#8E96AA]"
                        }`}
                      >
                        {done ? <Check aria-label="Done" className="h-[15px] w-[15px]" strokeWidth={3.2} /> : i + 1}
                      </span>
                      <span
                        className={`text-[16px] leading-tight ${
                          current ? "font-bold text-[#F5F7FA]" : done ? "font-semibold text-[#C5CBD8]" : "font-semibold text-[#8E96AA]"
                        }`}
                      >
                        {stepTitle(s)}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })}
            </nav>
          </aside>

          <div className={`flex min-w-0 flex-1 flex-col ${mainWidth}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-f1-mono text-[11px] font-extrabold tracking-[0.18em] text-[#CCFF00] uppercase">
                <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#CCFF00]" />
                {mode === "first-run" ? "First-time setup" : "Controls"} · Step {stepIndex + 1} of {steps.length}
              </div>
              <span className="not-compact:hidden">
                <LibreCorsaLogo variant="compact" className="hidden sm:inline-flex" />
              </span>
            </div>
            <h1 className="lc-disp mt-3 text-[clamp(30px,min(5.4vw,9vh),76px)] text-[#F5F7FA] short:mt-1 short:text-[26px]">
              {info.title}
            </h1>
            <p className="mt-3 text-[15px] leading-snug text-[#C5CBD8] sm:text-[17px] short:hidden">{info.detail}</p>

            {/* Progress rail (phones and short windows, where the step rail is hidden) */}
            <div className="mt-4 flex gap-1.5 not-compact:hidden short:mt-2">
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    i < stepIndex ? "bg-[#00E5FF]" : i === stepIndex ? "bg-[#CCFF00]" : "bg-[#262B3D]"
                  }`}
                />
              ))}
            </div>

            <div
              ref={bodyRef}
              className="-mx-1.5 mt-4 min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-2 not-compact:mt-6 short:mt-2"
            >
              {step === "device" ? <DeviceStep {...props} autoDetect={mode === "first-run"} /> : null}
              {step === "setup" && props.settings.device === "keyboard" ? <KeyboardStep {...props} /> : null}
              {step === "setup" && props.settings.device === "controller" ? <ControllerStep {...props} /> : null}
              {step === "setup" && props.settings.device === "wheel" ? <WheelStep {...props} /> : null}
              {step === "assists" ? <AssistsStep {...props} /> : null}
              {step === "car" ? <CarStep {...props} /> : null}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3.5 border-t border-[#262B3D]/70 pt-4 short:mt-2 short:pt-2">
          <div className="flex items-center gap-[18px]">
            <PrimaryButton tone="dark" onClick={back} prompt={pad ? <PadGlyph button="b" family={family} /> : "ESC"}>
              {stepIndex === 0 ? (mode === "first-run" ? "Main menu" : "Close") : "Back"}
            </PrimaryButton>
            {onSkip && !last ? (
              <button
                type="button"
                onClick={onSkip}
                className="min-h-[44px] cursor-pointer border-0 bg-transparent p-0 font-f1-mono text-[11px] font-extrabold tracking-[0.14em] text-[#8E96AA] uppercase transition-colors duration-200 hover:text-[#CCFF00]"
              >
                Skip · use defaults
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-[22px]">
            <PromptBar
              className="hidden sm:flex"
              prompts={[
                { action: "move", label: "Move" },
                { action: "select", label: "Select" },
                { action: "tabs", label: "Step" },
              ]}
            />
            <PrimaryButton onClick={next} prompt={pad ? <PadGlyph button="menu" family={family} /> : "ENTER"}>
              {last ? (mode === "first-run" ? "Lights out" : "Done") : "Next"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
};
