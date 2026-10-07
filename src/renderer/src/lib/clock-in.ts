import type { Translate } from '@shared/i18n'
import { LOCATIONS } from '@renderer/components/LocationSelect'

/**
 * Clocks in, asking where the work happens first when the setting says so.
 *
 * The question is a native menu hanging from the button that was pressed,
 * the same one the break picker uses (`BreakMenu.tsx`): office, remote,
 * business trip, with the remembered one marked. Picking writes the choice
 * back as the new default, so the next clock-in with the question switched
 * off lands at the same place. Dismissing the menu clocks nobody in.
 *
 * Shared by the widget and the app window — the same button in two places,
 * and one place for what pressing it means.
 */
/**
 * The location menu itself, hanging from the pressed button with `current`
 * marked. Picking is remembered as the new default; dismissing returns null.
 */
async function askLocation(anchor: DOMRect, current: string, t: Translate): Promise<string | null> {
  const picked = await window.factorial
    .popupMenu(
      LOCATIONS.map((location) => ({
        id: location.value,
        label: t(location.key),
        checked: location.value === current,
      })),
      { x: anchor.left, y: anchor.bottom },
    )
    .catch(() => null)
  // Remembered before the action rather than after: the choice is the
  // user's either way, and a write that fails is no reason to forget it.
  if (picked !== null) void window.factorial.setSettings({ lastLocationType: picked }).catch(() => {})
  return picked
}

export async function clockInFromButton(input: {
  ask: boolean
  lastLocationType: string
  workplaceId: number | null
  anchor: DOMRect
  t: Translate
}): Promise<'clocked-in' | 'dismissed'> {
  let locationType = input.lastLocationType
  if (input.ask) {
    const picked = await askLocation(input.anchor, input.lastLocationType, input.t)
    if (picked === null) return 'dismissed'
    locationType = picked
  }
  await window.factorial.clockIn({ locationType, workplaceId: input.workplaceId })
  return 'clocked-in'
}

/**
 * Ends the break, asking where the work goes on first when the setting says
 * so — for whoever changes place over lunch. The marked entry is where the
 * shift ran before the break. Off, the shift resumes at its own location;
 * dismissing the menu leaves the break running.
 */
export async function resumeFromButton(input: {
  ask: boolean
  currentLocationType: string
  anchor: DOMRect
  t: Translate
}): Promise<'resumed' | 'dismissed'> {
  if (!input.ask) {
    await window.factorial.endBreak()
    return 'resumed'
  }
  const picked = await askLocation(input.anchor, input.currentLocationType, input.t)
  if (picked === null) return 'dismissed'
  await window.factorial.endBreak({ locationType: picked })
  return 'resumed'
}
