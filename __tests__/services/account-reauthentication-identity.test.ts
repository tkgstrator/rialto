import { describe, expect, test } from 'bun:test'
import { assertReauthenticationIdentity } from '../../src/services/account-reauthentication'
import { buildCodexDiscoveredAccount } from '../../src/services/subscription-account-sync/discovery'

const token = (subject: string, user: string, workspace = 'workspace', field = 'chatgpt_user_id') =>
  `header.${Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_id: workspace, [field]: user } })).toString('base64url')}.sig`

function incoming(subject: string, user: string, workspace = 'workspace', field = 'chatgpt_user_id') {
  const account = buildCodexDiscoveredAccount({
    accessToken: 'access',
    refreshToken: 'refresh',
    idToken: token(subject, user, workspace, field)
  })
  if (account === null) throw new Error('Invalid fixture')
  return account
}

const target = { userId: 'old-subject', accountId: 'workspace', idToken: token('old-subject', 'selected-user') }

describe('Codex reauthentication identity', () => {
  test('accepts the same ChatGPT user and workspace when the JWT subject changes', () => {
    expect(() =>
      assertReauthenticationIdentity('codex', target, incoming('new-subject', 'selected-user'))
    ).not.toThrow()
  })

  test('recognizes the official user_id claim alias on a new token', () => {
    expect(() =>
      assertReauthenticationIdentity('codex', target, incoming('new-subject', 'selected-user', 'workspace', 'user_id'))
    ).not.toThrow()
  })

  test('rejects another ChatGPT user even when the raw subjects happen to match', () => {
    expect(() => assertReauthenticationIdentity('codex', target, incoming('old-subject', 'different-user'))).toThrow()
  })

  test('rejects the same user signing into a different workspace', () => {
    expect(() =>
      assertReauthenticationIdentity('codex', target, incoming('new-subject', 'selected-user', 'other-workspace'))
    ).toThrow()
  })

  test('preserves legacy subject checks when a stored identity token is unavailable', () => {
    const legacy = { ...target, idToken: null }
    expect(() =>
      assertReauthenticationIdentity('codex', legacy, incoming('old-subject', 'selected-user'))
    ).not.toThrow()
    expect(() => assertReauthenticationIdentity('codex', legacy, incoming('new-subject', 'selected-user'))).toThrow()
  })
})
