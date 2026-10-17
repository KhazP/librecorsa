import type { AssistPreset, CameraMode, LiveryConfig, VehicleModelId } from "@/types/f1";
import type { PlayerSettings } from "@/lib/settings/player-settings";

/** What the setup steps read and change */
export interface SetupStepProps {
  settings: PlayerSettings;
  onChangeSettings: (update: (prev: PlayerSettings) => PlayerSettings) => void;
  vehicleModel: VehicleModelId;
  onChangeVehicle: (vehicle: VehicleModelId) => void;
  selectedLivery: LiveryConfig;
  onChangeLivery: (livery: LiveryConfig) => void;
  assistPreset: AssistPreset;
  onChangeAssistPreset: (preset: AssistPreset) => void;
  showRacingLine: boolean;
  onSetRacingLine: (visible: boolean) => void;
  gamepadAssist: boolean;
  onSetGamepadAssist: (enabled: boolean) => void;
  gamepadRumble: boolean;
  onToggleGamepadRumble: () => void;
  mouseSteerEnabled: boolean;
  onSetMouseSteer: (enabled: boolean) => void;
  cameraMode: CameraMode;
  onChangeCameraMode: (mode: CameraMode) => void;
}
