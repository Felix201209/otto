/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
function hasValue(env, name) { return typeof env[name] === 'string' && env[name].trim().length > 0; }
export function inspectReleaseSigningConfig({ env = process.env, mode = 'release', platforms = ['windows', 'macos'] } = {}) {
  const missing = [];
  for (const platform of platforms) {
    if (platform === 'windows') {
      if (!hasValue(env, 'WIN_CSC_LINK')) missing.push('windows: WIN_CSC_LINK (or the configured certificate secret)');
    } else if (platform === 'macos') {
      for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) if (!hasValue(env, name)) missing.push(`macos: ${name}`);
      if (!hasValue(env, 'CSC_LINK') && !hasValue(env, 'CSC_NAME')) missing.push('macos: CSC_LINK or CSC_NAME');
    } else missing.push(`unsupported signing platform: ${platform}`);
  }
  if (mode === 'local-simulate') return { ok: false, blocked: true, mode, platforms, missing, message: 'local simulation does not create or validate a platform signature; official release remains blocked' };
  if (mode !== 'release') throw new Error(`unsupported signing mode: ${mode}`);
  return { ok: missing.length === 0, blocked: missing.length > 0, mode, platforms, missing };
}
function parsePlatforms(argv) { const value = argv.find((arg) => arg.startsWith('--platforms='))?.split('=')[1]; return value ? value.split(',').filter(Boolean) : ['windows', 'macos']; }
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv.includes('--local-simulate') ? 'local-simulate' : 'release';
  const result = inspectReleaseSigningConfig({ mode, platforms: parsePlatforms(process.argv.slice(2)) });
  if (result.ok) console.log(`[release-signing] credentials present for ${result.platforms.join(', ')}`);
  else { console.error(`[release-signing] blocked: ${result.message ?? result.missing.join('; ')}`); process.exitCode = 1; }
}
