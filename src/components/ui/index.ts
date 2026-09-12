/**
 * The UI kit: the components every screen is built from.
 *
 * The kit is deliberately small and has no third-party dependency. A component
 * belongs here when two screens need it and it is in the Figma Components
 * page; anything used once stays next to its screen.
 */

export { Badge, type BadgeTone } from "./Badge";
export { Button, type ButtonSize, type ButtonVariant } from "./Button";
// --- slice: connect dialog ---
export { Combobox, type ComboboxOption } from "./Combobox";
export { Dialog, type DialogVariant } from "./Dialog";
export { EmptyState } from "./EmptyState";
export { Input } from "./Input";
// --- slice: server actions ---
// --- slice: selection context menu --- `useContextMenu`: the same list,
// opened by a right click instead of the three dots.
export { Menu, useContextMenu, type MenuItem, type MenuSize } from "./Menu";
export { NavItem } from "./NavItem";
export { RadioCard } from "./RadioCard";
export {
  Select,
  type SelectOption,
  type SelectSize,
} from "./Select";
export { StepBadges, type StepBadge } from "./StepBadges";
export { Toggle } from "./Toggle";
// --- slice: installer ---
export { Toast, type ToastVariant } from "./Toast";
// --- slice: friends ---
export {
  Avatar,
  initials,
  type AvatarSize,
  type AvatarStatus,
} from "./Avatar";
