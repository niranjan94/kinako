import type { NotificationSoundTheme } from "@t3tools/contracts/settings";

// Desktop CSP blocks fetching data URLs, so even small audio files must stay external.
import completionUrl from "./assets/notification-completion.mp3?no-inline";
import inputUrl from "./assets/notification-input.mp3?no-inline";
import aoe2Completion from "./assets/notification-sounds/aoe2-completion.mp3?no-inline";
import aoe2Input from "./assets/notification-sounds/aoe2-input.mp3?no-inline";
import argentoCompletion from "./assets/notification-sounds/argento-completion.mp3?no-inline";
import argentoInput from "./assets/notification-sounds/argento-input.mp3?no-inline";
import minecraftCompletion from "./assets/notification-sounds/minecraft-completion.mp3?no-inline";
import minecraftInput from "./assets/notification-sounds/minecraft-input.mp3?no-inline";
import reCompletion from "./assets/notification-sounds/re-completion.mp3?no-inline";
import reInput from "./assets/notification-sounds/re-input.mp3?no-inline";
import retroCompletion from "./assets/notification-sounds/retro-completion.mp3?no-inline";
import retroInput from "./assets/notification-sounds/retro-input.mp3?no-inline";
import simsCompletion from "./assets/notification-sounds/sims-completion.mp3?no-inline";
import simsInput from "./assets/notification-sounds/sims-input.mp3?no-inline";
import smoothCompletion from "./assets/notification-sounds/smooth-completion.mp3?no-inline";
import smoothInput from "./assets/notification-sounds/smooth-input.mp3?no-inline";

export const NOTIFICATION_SOUND_THEMES = {
  default: { label: "Default", completion: completionUrl, input: inputUrl },
  smooth: { label: "Smooth Notifications", completion: smoothCompletion, input: smoothInput },
  aoe2: { label: "Age of Empires 2", completion: aoe2Completion, input: aoe2Input },
  retro: { label: "Retro Computing", completion: retroCompletion, input: retroInput },
  minecraft: { label: "Minecraft", completion: minecraftCompletion, input: minecraftInput },
  sims: { label: "The Sims", completion: simsCompletion, input: simsInput },
  re: { label: "Resident Evil", completion: reCompletion, input: reInput },
  argento: { label: "Argento", completion: argentoCompletion, input: argentoInput },
} satisfies Record<NotificationSoundTheme, { label: string; completion: string; input: string }>;
