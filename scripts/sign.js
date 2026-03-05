/**
 * Azure Trusted Signing — code signing hook for electron-builder.
 *
 * Referenced in electron-builder.yml as:
 *   win:
 *     sign: scripts/sign.js
 *
 * Required environment variables (store in CI secrets / local .env — NEVER commit):
 *   AZURE_TENANT_ID
 *   AZURE_CLIENT_ID
 *   AZURE_CLIENT_SECRET
 *   AZURE_TRUSTED_SIGNING_ACCOUNT
 *   AZURE_TRUSTED_SIGNING_ENDPOINT   e.g. https://eus.codesigning.azure.net
 *   AZURE_CERTIFICATE_PROFILE
 *
 * Installation (one-time):
 *   npm install --save-dev @azure/trusted-signing-cli
 */
const { execSync } = require('child_process');

exports.default = async function sign(configuration) {
  const filePath = configuration.path;

  // Only sign .exe files
  if (!filePath || !filePath.endsWith('.exe')) return;

  const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_TRUSTED_SIGNING_ACCOUNT,
    AZURE_TRUSTED_SIGNING_ENDPOINT,
    AZURE_CERTIFICATE_PROFILE
  } = process.env;

  // Skip gracefully if env vars aren't set (e.g. local dev builds)
  if (
    !AZURE_TENANT_ID ||
    !AZURE_CLIENT_ID ||
    !AZURE_CLIENT_SECRET ||
    !AZURE_TRUSTED_SIGNING_ACCOUNT ||
    !AZURE_TRUSTED_SIGNING_ENDPOINT ||
    !AZURE_CERTIFICATE_PROFILE
  ) {
    console.warn('[sign.js] Azure Trusted Signing env vars not set — skipping code signing.');
    return;
  }

  console.log(`[sign.js] Signing: ${filePath}`);

  execSync(
    [
      'trusted-signing-cli sign',
      `--file-list "${filePath}"`,
      `--publisher-name "Pixfizz"`,
      `--description "OrderHub Downloader"`,
      `--description-url "https://orderhub.app"`,
      `--azure-key-vault-tenant-id "${AZURE_TENANT_ID}"`,
      `--azure-key-vault-client-id "${AZURE_CLIENT_ID}"`,
      `--azure-key-vault-client-secret "${AZURE_CLIENT_SECRET}"`,
      `--trusted-signing-account "${AZURE_TRUSTED_SIGNING_ACCOUNT}"`,
      `--trusted-signing-endpoint "${AZURE_TRUSTED_SIGNING_ENDPOINT}"`,
      `--trusted-signing-certificate-profile "${AZURE_CERTIFICATE_PROFILE}"`
    ].join(' '),
    { stdio: 'inherit' }
  );
};
