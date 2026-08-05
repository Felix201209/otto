import { readFile } from 'node:fs/promises';
import process from 'node:process';

const defaultPath = new URL('../deployment/aliyun/otto-compute-nest-contract.json', import.meta.url);
const contractPath = process.argv[2] ? new URL(`file://${process.argv[2]}`) : defaultPath;
const forbidden = /(password|secret(value)?$|accesskey(secret)?$|license|privatekey|connection(string)?)/i;
const fail = (message) => { throw new Error(`[aliyun-contract] ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const contract = JSON.parse(await readFile(contractPath, 'utf8'));
assert(contract.format === 'otto-aliyun-compute-nest-contract-v1', 'unsupported contract format');
assert(contract.realDeploymentEnabled === false, 'local contract must not enable real cloud deployment');
assert(Array.isArray(contract.supportedRegions) && contract.supportedRegions.length > 0, 'supported regions are required');
assert(isObject(contract.plans), 'plans are required');
for (const plan of ['trial', 'standard', 'ha']) {
  const value = contract.plans[plan];
  assert(isObject(value), `${plan} plan is required`);
  assert(value.availabilityZones >= 1 && value.statelessServers >= 1, `${plan} capacity is invalid`);
  for (const service of ['postgres', 'tair', 'oss']) {
    assert(isObject(value[service]), `${plan}.${service} is required`);
    assert(value[service].public === false, `${plan}.${service} must be private`);
  }
  assert(value.oss.versioning === true && value.oss.sseKms === true, `${plan}.oss must use versioning and KMS encryption`);
}
assert(contract.network.tls.httpsRequired === true && contract.network.tls.minimumVersion === '1.2', 'TLS must be HTTPS with TLS 1.2 minimum');
assert(JSON.stringify(contract.network.publicPorts) === '[443]', 'only 443 may be public');
assert(contract.network.ssh.defaultEnabled === false, 'SSH must default to disabled');
assert(contract.secrets.plaintextAllowed === false && contract.secrets.missingDependencyAction === 'fail-closed', 'secrets must fail closed');
assert(contract.idempotency.replayMustNotCreateResources === true, 'replays must not create resources');
assert(Array.isArray(contract.idempotency.requiredFields) && contract.idempotency.requiredFields.includes('idempotencyKey'), 'idempotency key is required');
assert(contract.evidence.realCloudRunRequiredForCompletion === true, 'real cloud evidence requirement must remain explicit');
for (const listPath of [contract.parameters.allowed, contract.parameters.forbidden, contract.outputs.allowed, contract.outputs.forbidden]) {
  assert(Array.isArray(listPath), 'contract field lists must be arrays');
}
for (const entry of [...contract.parameters.allowed, ...contract.outputs.allowed]) {
  assert(!forbidden.test(entry), `plaintext or secret-like field is allowed: ${entry}`);
}
for (const [from, destinations] of Object.entries(contract.states.transitions)) {
  assert(Array.isArray(destinations) && destinations.length > 0, `state ${from} has no transitions`);
  for (const destination of destinations) assert(destination in contract.states.transitions, `unknown state ${destination}`);
}
assert(contract.states.initial in contract.states.transitions, 'initial state is unknown');
for (const terminal of contract.states.terminal) assert(contract.states.transitions[terminal], `terminal state ${terminal} is unknown`);
console.log(`[aliyun-contract] valid: ${contract.templateVersion}; realDeploymentEnabled=${contract.realDeploymentEnabled}`);
