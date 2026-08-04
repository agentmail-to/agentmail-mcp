import assert from 'node:assert/strict'
import test from 'node:test'

import { validateClerkOAuthSettings } from '../scripts/check-clerk-oauth-settings.mjs'

test('accepts the required Clerk OAuth settings', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
      default_scopes: ['profile', 'openid', 'email'],
    }),
    [],
  )
})

test('reports settings that would break ChatGPT OAuth', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: false,
      oauth_jwt_access_tokens: false,
      default_scopes: ['email', 'profile'],
    }),
    [
      'dynamic OAuth client registration is disabled',
      'OAuth JWT access tokens are disabled',
      'default scopes are missing: openid',
    ],
  )
})

test('reports unset default scopes from the production regression', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
      default_scopes: null,
    }),
    ['default scopes are missing: openid, email, profile'],
  )
})
