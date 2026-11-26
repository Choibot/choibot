// src/components/settings/sections.tsx — the sections of the Settings page, in the order of its
// list. To add a section, write its body (a component that takes SectionProps and starts with
// <StatusLine>, see kit.tsx) and add ONE line to SETTINGS_SECTIONS below. `group` is the small
// heading above a run of rows; a new group name starts a new heading.
import type { ComponentType, ReactNode } from "react";
import { FlagIcon, FolderIcon, PersonIcon } from "../SideIcons";
import type { SectionProps } from "./kit";
// Brain sections (their own lines, so the Add-ons imports below never touch them).
import { DeviceIcon, RulesIcon } from "../SideIcons";
import { DevicesSettings } from "./DevicesSettings";
import { RulesSettings } from "./RulesSettings";
import { LeadsSettings } from "./LeadsSettings";
import { AccountsSettings } from "./AccountsSettings";
import { ReposSettings } from "./ReposSettings";
import { GitHubIcon, SendIcon } from "../SideIcons";
import { TelegramSettings } from "./TelegramSettings";
import { GitHubSettings } from "./GitHubSettings";
// Share outside (its own lines).
import { ExternalIcon } from "../SideIcons";
import { ShareSettings } from "./ShareSettings";
// The set-up steps (its own lines).
import { CheckIcon } from "../SideIcons";
import { SetupSettings } from "./SetupSettings";
// The version this console runs (its own lines).
import { CodeIcon } from "../SideIcons";
import { VersionSettings } from "./VersionSettings";

export type SettingsSection = {
  id: string;          // the page's key for it: lowercase, stable (a link opens it by id)
  label: string;       // the row and the title
  group: string;       // the heading it sits under
  icon: ReactNode;     // an icon of SideIcons.tsx
  Body: ComponentType<SectionProps>;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "leads", label: "Leads", group: "Agents", icon: <FlagIcon />, Body: LeadsSettings },
  { id: "accounts", label: "Claude accounts", group: "Agents", icon: <PersonIcon />, Body: AccountsSettings },
  { id: "repos", label: "Repos", group: "Agents", icon: <FolderIcon />, Body: ReposSettings },

  // Add-ons (Telegram, GitHub) come here.
  { id: "telegram", label: "Telegram", group: "Add-ons", icon: <SendIcon />, Body: TelegramSettings },
  { id: "github", label: "GitHub", group: "Add-ons", icon: <GitHubIcon />, Body: GitHubSettings },
  { id: "share", label: "Share outside", group: "Add-ons", icon: <ExternalIcon size={16} />, Body: ShareSettings },

  // Brain (Rules, Devices) comes here.
  { id: "rules", label: "Rules", group: "Brain", icon: <RulesIcon />, Body: RulesSettings },
  { id: "devices", label: "Devices", group: "Brain", icon: <DeviceIcon />, Body: DevicesSettings },

  // The version this console runs, then the checklist of the set-up steps: the last row, quiet
  // when every step passes.
  { id: "version", label: "Version", group: "Console", icon: <CodeIcon size={16} />, Body: VersionSettings },
  { id: "setup", label: "Set-up", group: "Console", icon: <CheckIcon size={16} />, Body: SetupSettings },
];

export const sectionById = (id: string | null | undefined): SettingsSection | undefined =>
  SETTINGS_SECTIONS.find((d) => d.id === id);
