import type { ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const keyOf = (value: string) => `option:${value}`

export function SelectPicker({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  reading
}: {
  id?: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  reading?: ReactNode
}) {
  return (
    <Select value={keyOf(value)} onValueChange={(key) => onChange(key.slice('option:'.length))} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className={className} size='sm'>
        <SelectValue>{reading}</SelectValue>
      </SelectTrigger>
      <SelectContent position='popper'>
        {options.map((option) => (
          <SelectItem key={option.value} value={keyOf(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
