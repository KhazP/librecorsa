import type { RaceControlFeedMessage } from "@/types/f1";

export type RaceControlMessageKey =
  | "virtualSafetyCar"
  | "vscEnding"
  | "greenFlag"
  | "yellowFlag"
  | "doubleYellow"
  | "trackClear"
  | "positionHandedBack"
  | "blueFlagWarning"
  | "warning"
  | "noFurtherAction"
  | "racingIncident"
  | "youOut"
  | "driverOut"
  | "contactWith"
  | "driverDisqualified"
  | "overtakeUnderVsc"
  | "overtakeUnderDoubleYellow"
  | "overtakeUnderYellow"
  | "playerTimePenalty"
  | "driverTimePenalty"
  | "vscMaintainDelta"
  | "vscPrepareGreen"
  | "trackClearResumes"
  | "vscDeltaInfringement"
  | "vscDeltaNegativeAtGreen"
  | "carStoppedSlowNoOvertake"
  | "incidentAheadNoOvertake"
  | "underInvestigation"
  | "causingCollision"
  | "causingCollisionWith"
  | "trackLimits"
  | "damage"
  | "givePlaceBackTo"
  | "overtakingUnderVsc"
  | "overtakingUnderDoubleYellow"
  | "overtakingUnderYellow"
  | "letThrough"
  | "ignoringBlueFlag"
  | "contactReasonHitAhead"
  | "contactReasonMovedAlongside"
  | "contactReasonRacingIncident"
  | "driverReasonHitAhead"
  | "driverReasonMovedAlongside"
  | "driverReasonRacingIncident"
  | "pitStopMissed"
  | "pitSpeeding"
  | "jumpStart"
  | "bigJumpStart"
  | "carStopped"
  | "slowCar"
  | "wrongWay"
  | "carOffTrack"
  | "incidentAhead";

export type RaceControlTranslate = (key: RaceControlMessageKey, values?: Record<string, string | number>) => string;

const STATIC_TEXT: Readonly<Record<string, RaceControlMessageKey>> = {
  "Virtual Safety Car": "virtualSafetyCar",
  "VSC ending": "vscEnding",
  "Green flag": "greenFlag",
  "Yellow flag": "yellowFlag",
  "Double yellow": "doubleYellow",
  "Track clear": "trackClear",
  "Position handed back": "positionHandedBack",
  "Blue flag warning": "blueFlagWarning",
  Warning: "warning",
  "No further action": "noFurtherAction",
  "Racing incident": "racingIncident",
  "You are out of the race": "youOut",
  "Overtake under VSC": "overtakeUnderVsc",
  "Overtake under double yellow": "overtakeUnderDoubleYellow",
  "Overtake under yellow": "overtakeUnderYellow",
};

const STATIC_DETAIL: Readonly<Record<string, RaceControlMessageKey>> = {
  "Maintain positive delta · no overtaking": "vscMaintainDelta",
  "Hold positive delta · prepare for green": "vscPrepareGreen",
  "Track clear · racing resumes": "trackClearResumes",
  "VSC delta infringement": "vscDeltaInfringement",
  "VSC delta negative at green flag": "vscDeltaNegativeAtGreen",
  "Car stopped ahead · slow down, no overtaking": "carStoppedSlowNoOvertake",
  "Incident ahead · no overtaking": "incidentAheadNoOvertake",
  "No further action": "noFurtherAction",
  "Under investigation": "underInvestigation",
  "Causing a collision": "causingCollision",
  "Track limits": "trackLimits",
  Damage: "damage",
  "Jump start": "jumpStart",
  "Jump start · well off the grid spot": "bigJumpStart",
  "Car stopped ahead": "carStopped",
  "Slow car ahead": "slowCar",
  "Car going the wrong way": "wrongWay",
  "Car off the track ahead": "carOffTrack",
  "Incident ahead": "incidentAhead",
};

const RE_PLAYER_PENALTY = /^(\d+(?:\.\d+)?)\s*s time penalty$/;
const RE_DRIVER_PENALTY = /^(.+?)\s*·\s*(\d+(?:\.\d+)?)\s*s penalty$/;
const RE_DRIVER_OUT = /^(.+?)\s+is out of the race$/;
const RE_CONTACT_WITH = /^Contact with (.+)$/;
const RE_DRIVER_DQ = /^(.+?)\s+disqualified$/;

const RE_GIVE_BACK_TO = /^Give the place back to (.+)$/;
const RE_OVERTAKING_UNDER = /^Overtaking under (VSC|double yellow|yellow)\s*·\s*(.+)$/;
const RE_LET_THROUGH = /^Let (.+) through$/;
const RE_IGNORING_BLUE = /^Ignoring blue flag\s*·\s*(.+)$/;
const RE_COLLISION_WITH = /^Causing a collision with (.+)$/;
const RE_CONTACT_REASON = /^Contact with (.+?)\s*·\s*(hit the car ahead|moved into a car alongside|racing incident)$/i;
const RE_DRIVER_REASON = /^(.+?)\s*·\s*(hit the car ahead|moved into a car alongside|racing incident)$/i;
const RE_PIT_STOP_ONE = /^Required pit stop not made$/;
const RE_PIT_STOP_MANY = /^(\d+)\s+required pit stops not made$/;
const RE_PIT_SPEEDING = /^Pit lane speeding \(over (\d+)\s*km\/h\)$/;

/** Translates a race-control feed title emitted by the simulation into the active UI language */
export function localizeRaceControlText(text: string, t: RaceControlTranslate): string {
  const staticKey = STATIC_TEXT[text];
  if (staticKey) return t(staticKey);

  let m = RE_PLAYER_PENALTY.exec(text);
  if (m) return t("playerTimePenalty", { seconds: m[1] });

  m = RE_DRIVER_PENALTY.exec(text);
  if (m) return t("driverTimePenalty", { driver: m[1], seconds: m[2] });

  m = RE_DRIVER_OUT.exec(text);
  if (m) return t("driverOut", { driver: m[1] });

  m = RE_CONTACT_WITH.exec(text);
  if (m) return t("contactWith", { driver: m[1] });

  m = RE_DRIVER_DQ.exec(text);
  if (m) return t("driverDisqualified", { driver: m[1] });

  return text;
}

/** Translates a race-control feed subtitle/detail emitted by the simulation into the active UI language */
export function localizeRaceControlDetail(detail: string, t: RaceControlTranslate): string {
  const staticKey = STATIC_DETAIL[detail];
  if (staticKey) return t(staticKey);

  if (RE_PIT_STOP_ONE.test(detail)) return t("pitStopMissed", { count: 1 });

  let m = RE_PIT_STOP_MANY.exec(detail);
  if (m) return t("pitStopMissed", { count: Number(m[1]) });

  m = RE_PIT_SPEEDING.exec(detail);
  if (m) return t("pitSpeeding", { limit: Number(m[1]) });

  m = RE_GIVE_BACK_TO.exec(detail);
  if (m) return t("givePlaceBackTo", { driver: m[1] });

  m = RE_OVERTAKING_UNDER.exec(detail);
  if (m) {
    const key: RaceControlMessageKey =
      m[1] === "VSC" ? "overtakingUnderVsc" : m[1] === "double yellow" ? "overtakingUnderDoubleYellow" : "overtakingUnderYellow";
    return t(key, { driver: m[2] });
  }

  m = RE_LET_THROUGH.exec(detail);
  if (m) return t("letThrough", { driver: m[1] });

  m = RE_IGNORING_BLUE.exec(detail);
  if (m) return t("ignoringBlueFlag", { driver: m[1] });

  m = RE_COLLISION_WITH.exec(detail);
  if (m) return t("causingCollisionWith", { driver: m[1] });

  m = RE_CONTACT_REASON.exec(detail);
  if (m) {
    const reason = m[2].toLowerCase();
    const key: RaceControlMessageKey =
      reason === "hit the car ahead"
        ? "contactReasonHitAhead"
        : reason === "moved into a car alongside"
          ? "contactReasonMovedAlongside"
          : "contactReasonRacingIncident";
    return t(key, { driver: m[1] });
  }

  m = RE_DRIVER_REASON.exec(detail);
  if (m) {
    const reason = m[2].toLowerCase();
    const key: RaceControlMessageKey =
      reason === "hit the car ahead"
        ? "driverReasonHitAhead"
        : reason === "moved into a car alongside"
          ? "driverReasonMovedAlongside"
          : "driverReasonRacingIncident";
    return t(key, { driver: m[1] });
  }

  return detail;
}

/** Localizes both title and optional detail of a race-control feed message */
export function localizeRaceControlMessage(
  msg: Pick<RaceControlFeedMessage, "text" | "detail">,
  t: RaceControlTranslate,
): { text: string; detail?: string } {
  return {
    text: localizeRaceControlText(msg.text, t),
    detail: msg.detail ? localizeRaceControlDetail(msg.detail, t) : undefined,
  };
}
