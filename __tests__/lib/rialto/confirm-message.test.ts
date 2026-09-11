/**
 * Confirm copy split into an AlertDialog's title and description.
 *
 * The strings are the app's own, interpolated, in all three locales: the
 * split is only right if it is right for the messages that actually ship.
 */

import { describe, expect, test } from 'bun:test'
import { splitConfirmMessage } from '../../../src/lib/rialto/confirm-message'

describe('splitConfirmMessage', () => {
  test('a leading question becomes the title and the rest the description', () => {
    expect(splitConfirmMessage('Revoke "CI"? Any client using it stops working immediately.')).toEqual({
      title: 'Revoke "CI"?',
      description: 'Any client using it stops working immediately.'
    })
  })

  test('the blank lines after a question are not part of the description', () => {
    expect(splitConfirmMessage('Delete "CI" permanently?\n\nIt is already revoked.')).toEqual({
      title: 'Delete "CI" permanently?',
      description: 'It is already revoked.'
    })
  })

  test('a ? inside a quoted name does not cut the title short', () => {
    expect(splitConfirmMessage('Revoke "why?"? Any client using it stops working immediately.')).toEqual({
      title: 'Revoke "why?"?',
      description: 'Any client using it stops working immediately.'
    })
  })

  test('a full-width question mark ends the question with or without a space after it', () => {
    expect(
      splitConfirmMessage('「CI」を失効させますか？ これを使っているクライアントは即座に動かなくなります。')
    ).toEqual({
      title: '「CI」を失効させますか？',
      description: 'これを使っているクライアントは即座に動かなくなります。'
    })
    expect(splitConfirmMessage('归档所有活跃会话吗？它们会从活动中消失，但用量与费用汇总会保留。')).toEqual({
      title: '归档所有活跃会话吗？',
      description: '它们会从活动中消失，但用量与费用汇总会保留。'
    })
  })

  test('a question that closes the message becomes the title, the sentence before it the description', () => {
    expect(splitConfirmMessage('You have unsaved changes on this screen. Leave and discard them?')).toEqual({
      title: 'Leave and discard them?',
      description: 'You have unsaved changes on this screen.'
    })
    expect(splitConfirmMessage('この画面に保存していない変更があります。破棄して移動しますか？')).toEqual({
      title: '破棄して移動しますか？',
      description: 'この画面に保存していない変更があります。'
    })
  })

  test('a message with no question is all title', () => {
    expect(splitConfirmMessage('This cannot be undone.')).toEqual({ title: 'This cannot be undone.', description: '' })
  })
})
