import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SETTINGS_URL = 'https://api.clerk.com/v1/instance/oauth_application_settings'
const REQUIRED_DEFAULT_SCOPES = ['openid', 'email', 'profile']

export function validateClerkOAuthSettings(settings) {
  const errors = []

  if (settings.dynamic_oauth_client_registration !== true) {
    errors.push('dynamic OAuth client registration is disabled')
  }
  if (settings.oauth_jwt_access_tokens !== true) {
    errors.push('OAuth JWT access tokens are disabled')
  }

  const defaultScopes = Array.isArray(settings.default_scopes) ? settings.default_scopes : []
  const missingScopes = REQUIRED_DEFAULT_SCOPES.filter((scope) => !defaultScopes.includes(scope))
  if (missingScopes.length > 0) {
    errors.push(`default scopes are missing: ${missingScopes.join(', ')}`)
  }

  return errors
}

async function main() {
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required')

  const response = await fetch(SETTINGS_URL, {
    headers: { authorization: `Bearer ${secretKey}` },
  })
  if (!response.ok) {
    throw new Error(`Clerk OAuth settings request failed with HTTP ${response.status}`)
  }

  const errors = validateClerkOAuthSettings(await response.json())
  if (errors.length > 0) {
    throw new Error(`Invalid Clerk OAuth settings: ${errors.join('; ')}`)
  }

  console.log('Clerk OAuth settings OK: DCR and JWT access tokens enabled; required defaults present')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
