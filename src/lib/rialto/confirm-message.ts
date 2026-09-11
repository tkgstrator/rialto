/**
 * Split a confirm message into the question a dialog title asks and the
 * sentences its description carries.
 *
 * The confirm copy was written for `window.confirm`, which has one text
 * block, so every message is a single string: usually the question first
 * ("Revoke "CI"? Any client using it stops working immediately."),
 * sometimes last ("You have unsaved changes on this screen. Leave and
 * discard them?"). An AlertDialog has a title and a description. Splitting
 * the strings that exist keeps en / ja / zh in step, where a second set of
 * title keys would be free to drift from the first.
 *
 * A half-width `?` only ends the question when whitespace or the end of the
 * message follows it, so a name like `"why?"` inside quotes does not cut the
 * title short. CJK copy puts no space after `？`, so that one always ends it.
 */
const LEADING_QUESTION = /^([\s\S]*?(?:\?(?=\s|$)|？))\s*([\s\S]*)$/
const TRAILING_QUESTION = /^([\s\S]*[.。])\s*([^.。]+[?？])$/

const group = (match: RegExpExecArray, index: number): string => {
  const value = match[index]
  return value === undefined ? '' : value
}

export function splitConfirmMessage(message: string): { title: string; description: string } {
  const leading = LEADING_QUESTION.exec(message)
  if (leading !== null && group(leading, 2).length > 0) {
    return { title: group(leading, 1), description: group(leading, 2) }
  }
  const trailing = TRAILING_QUESTION.exec(message)
  if (trailing !== null) return { title: group(trailing, 2), description: group(trailing, 1) }
  return { title: message, description: '' }
}
