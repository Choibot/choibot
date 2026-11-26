// src/components/settings/SetupSettings.tsx — the Set-up row of Settings: the checklist of the
// set-up steps (components/setup/SetupList). On a console where every required step passes it is
// one quiet row with a green dot; the list is also the way back to a step that broke later.
"use client";
import { progress, setupRows, setupStatus } from "../../lib/setup";
import { useSetup } from "../../lib/useSetup";
import { SetupList } from "../setup/SetupList";
import { StatusLine, type SectionProps } from "./kit";

export function SetupSettings({ phone, go }: SectionProps) {
  const setup = useSetup({ on: true });
  const { done, total } = progress(setupRows(setup.answer));
  return (
    <>
      <StatusLine status={setupStatus(done, total, setup.answer !== null, setup.failed)} />
      <SetupList setup={setup} phone={phone} nav={{ go }} counted />
    </>
  );
}
