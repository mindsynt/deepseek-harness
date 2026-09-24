/**
 * Deterministic cost amount formatting for the Chat usage dialogs.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/cost-format
 */

/**
 * Plain decimal formatter: two fraction digits keep the reading stable and
 * readable, and `useGrouping: false` keeps the value copyable without locale
 * thousands separators.
 */
const COST_FORMAT = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Format one estimated cost with exactly two fraction digits.
 *
 * The value is rounded to cents; a positive amount that rounds to `0.00`
 * still reads `0.00` because that is the reported precision of the reading.
 * @param amount - estimated cost in the pricing currency.
 * @returns the display string.
 */
export function formatCostAmount(amount: number): string {
  return COST_FORMAT.format(amount)
}
