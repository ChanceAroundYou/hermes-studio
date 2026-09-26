/**
 * One action button of a pending-interaction card. Hosts hand over plain data
 * (label + tone) so the card owns nothing but presentation.
 */
export interface PendingCardAction {
  key: string
  label: string
  variant?: 'primary' | 'default' | 'error'
  loading?: boolean
  disabled?: boolean
}
