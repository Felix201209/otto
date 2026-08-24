import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'deployment/aliyun/otto-compute-nest-contract.json');
const dangerousKey = /^(AccessKeyId|AccessKeySecret|PrivateKey|SecretData|License|Token)$/i;
const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const aliyunAccessKey = /\bLTAI[A-Za-z0-9]{12,}\b/;
const commonApiKey = /\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/;
const fail = (message) => { throw new Error(`[aliyun-secrets] ${message}`); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function isApprovedSecretRef(value, parameter) {
  return isObject(value) && value.Ref === parameter && Object.keys(value).length === 1;
}

function scanValue(value, trail, filePath) {
  if (typeof value === 'string') {
    if (privateKey.test(value) || aliyunAccessKey.test(value) || commonApiKey.test(value) || credentialUrl.test(value)) {
      fail(`${path.relative(root, filePath)} contains a credential-like literal at ${trail}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValue(entry, `${trail}[${index}]`, filePath));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childTrail = `${trail}.${key}`;
    if (dangerousKey.test(key)) fail(`${path.relative(root, filePath)} contains forbidden property ${childTrail}`);
    if (key === 'MasterUserPassword' && !isApprovedSecretRef(child, 'DatabaseCredentialRef')) {
      fail(`${path.relative(root, filePath)} database credential is not an encrypted reference`);
    }
    if (key === 'Password' && !isApprovedSecretRef(child, 'CacheCredentialRef')) {
      fail(`${path.relative(root, filePath)} cache credential is not an encrypted reference`);
    }
    if (key === 'UserData' || key === 'CommandContent') {
      fail(`${path.relative(root, filePath)} embeds bootstrap commands; use the signed CLOUD-02 artifact instead`);
    }
    scanValue(child, childTrail, filePath);
  }
}

const explicitFiles = process.argv.slice(2).map((entry) => path.resolve(entry));
let files = explicitFiles;
if (files.length === 0) {
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  files = Object.values(contract.templates.files).map((entry) => path.resolve(root, entry));
}

for (const filePath of files) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  scanValue(parsed, '$', filePath);
}

console.log(`[aliyun-secrets] clean: ${files.length} template(s)`);
