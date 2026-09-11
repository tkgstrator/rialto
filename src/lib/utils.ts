/**
 * `cn` comes from the `cn` package, the one shadcn's registry now imports.
 *
 * This re-export stays only for the three vendored components under
 * src/components/ui that are not in the shadcn registry (color-picker,
 * combo-input, multi-combobox). The CLI cannot regenerate them, and that
 * directory is never edited by hand. Everything else imports `cn` from 'cn'.
 */
export { cn } from 'cn'
