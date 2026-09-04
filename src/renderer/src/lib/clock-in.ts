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
export async function clockInFromButton(input: {
  ask: boolean
  lastLocationType: string
  workplaceId: number | null
  anchor: DOMRect
  t: Translate
}): Promise<'clocked-in' | 'dismissed'> {
  let locationType = input.lastLocationType
  if (input.ask) {
    const picked = await window.factorial
      .popupMenu(
        LOCATIONS.map((location) => ({
          id: location.value,
          label: input.t(location.key),
          checked: location.value === input.lastLocationType,
        })),
        { x: input.anchor.left, y: input.anchor.bottom },
      )
      .catch(() => null)
    if (picked === null) return 'dismissed'
    locationType = picked
    // Remembered before the clock-in rather than after: the choice is the
    // user's either way, and a clock-in that fails is no reason to forget it.
    void window.factorial.setSettings({ lastLocationType: picked }).catch(() => {})
  }
  await window.factorial.clockIn({ locationType, workplaceId: input.workplaceId })
  return 'clocked-in'
}
