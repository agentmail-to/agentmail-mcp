import assert from 'node:assert/strict'
import test from 'node:test'

import { validateClerkOAuthSettings } from '../scripts/check-clerk-oauth-settings.mjs'

test('accepts the required Clerk OAuth settings', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
      default_scopes: ['profile', 'user:org:read', 'openid', 'email'],
    }),
    [],
  )
})

test('reports settings that would break ChatGPT OAuth', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: false,
      oauth_jwt_access_tokens: false,
      default_scopes: ['email', 'profile', 'user:org:read'],
    }),
    [
      'dynamic OAuth client registration is disabled',
      'OAuth JWT access tokens are disabled',
      'default scopes are missing: openid',
    ],
  )
})

test('reports defaults that still predate the org scope', () => {
  // Clients that omit `scope` at registration (ChatGPT) inherit exactly these
  // defaults. Without `user:org:read` there, they would request the advertised
  // scope with a client that was never allowed it — the 2026-05-08 failure.
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
      default_scopes: ['openid', 'email', 'profile'],
    }),
    ['default scopes are missing: user:org:read'],
  )
})

test('reports unset default scopes from the production regression', () => {
  assert.deepEqual(
    validateClerkOAuthSettings({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
      default_scopes: null,
    }),
    ['default scopes are missing: openid, email, profile, user:org:read'],
  )
})
