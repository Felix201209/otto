import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPath = path.join(root, 'deployment/aliyun/otto-compute-nest-contract.json');
const definitionsPath = path.join(root, 'deployment/aliyun/plan-definitions.json');
const contractPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;
const forbiddenField = /(password|secret(value)?$|accesskey(secret)?$|license|privatekey|connection(string)?)/i;
const fail = (message) => { throw new Error(`[aliyun-contract] ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const normalizeOutputName = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

function resourcesOfType(template, type) {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

function isRef(value, parameter) {
  return isObject(value) && value.Ref === parameter && Object.keys(value).length === 1;
}

function validateTemplate(contract, planName, template, plan, definition) {
  const prefix = `template ${planName}`;
  assert(template.ROSTemplateFormatVersion === '2015-09-01', `${prefix} has an invalid ROS format version`);
  assert(isObject(template.Parameters), `${prefix} parameters are missing`);
  assert(isObject(template.Resources), `${prefix} resources are missing`);
  assert(isObject(template.Outputs), `${prefix} outputs are missing`);
  assert(template.Metadata?.Otto?.Plan === planName, `${prefix} metadata plan mismatch`);
  assert(template.Metadata?.Otto?.Stage === contract.templates.stage, `${prefix} stage mismatch`);
  assert(template.Metadata?.Otto?.RealDeploymentEnabled === false, `${prefix} must remain a local preview`);
  assert(template.Parameters.TemplateVersion?.Default === contract.templateVersion, `${prefix} version drift`);

  for (const parameter of ['DeploymentId', 'OrderId', 'IdempotencyKey', 'TemplateVersion', 'ZoneId', 'OttoImageId', 'DatabaseCredentialRef', 'CacheCredentialRef']) {
    assert(template.Parameters[parameter], `${prefix} is missing parameter ${parameter}`);
  }
  if (plan.availabilityZones > 1) {
    assert(template.Parameters.SecondaryZoneId, `${prefix} requires a secondary zone`);
  } else {
    assert(!template.Parameters.SecondaryZoneId, `${prefix} must not request a secondary zone`);
  }
  for (const parameter of ['DatabaseCredentialRef', 'CacheCredentialRef']) {
    const value = template.Parameters[parameter];
    assert(value.Type === 'ALIYUN::OOS::SecretParameter::Value', `${prefix}.${parameter} must use an OOS encrypted reference`);
    assert(value.NoEcho === true, `${prefix}.${parameter} must be NoEcho`);
    assert(!Object.hasOwn(value, 'Default'), `${prefix}.${parameter} must not have a default`);
  }
  const hidden = template.Metadata?.['ALIYUN::ROS::Interface']?.Hidden;
  assert(Array.isArray(hidden), `${prefix} hidden parameter list is missing`);
  for (const parameter of contract.parameters.systemManaged) {
    const rosName = `${parameter[0].toUpperCase()}${parameter.slice(1)}`;
    assert(hidden.includes(rosName), `${prefix} must hide system parameter ${rosName}`);
  }

  const resourceTypes = new Set(Object.values(template.Resources).map((resource) => resource.Type));
  for (const type of contract.templates.requiredResourceTypes) {
    assert(resourceTypes.has(type), `${prefix} is missing required resource ${type}`);
  }

  const switches = resourcesOfType(template, 'ALIYUN::ECS::VSwitch');
  assert(switches.length === plan.availabilityZones, `${prefix} vSwitch count does not match its availability zones`);
  const servers = resourcesOfType(template, 'ALIYUN::ECS::InstanceGroup');
  const serverCount = servers.reduce((total, [, resource]) => total + resource.Properties.MaxAmount, 0);
  assert(serverCount === plan.statelessServers, `${prefix} stateless server count mismatch`);
  for (const [name, server] of servers) {
    assert(server.Properties.InstanceType === definition.instanceType, `${prefix}.${name} instance type drift`);
    assert(server.Properties.SystemDiskSize === definition.systemDiskSize, `${prefix}.${name} disk size drift`);
    assert(server.Properties.AllocatePublicIP === false, `${prefix}.${name} must not allocate a public IP`);
    assert(server.Properties.InternetMaxBandwidthOut === 0, `${prefix}.${name} public bandwidth must be zero`);
    assert(!Object.hasOwn(server.Properties, 'Password'), `${prefix}.${name} must not contain a login password`);
    assert(!Object.hasOwn(server.Properties, 'KeyPairName'), `${prefix}.${name} must not expose SSH credentials`);
    assert(!Object.hasOwn(server.Properties, 'UserData'), `${prefix}.${name} bootstrap belongs to signed CLOUD-02 artifacts`);
    assert(server.Properties.SystemDiskEncrypted === 'true', `${prefix}.${name} system disk must be encrypted`);
    assert(server.Properties.RamRoleName, `${prefix}.${name} must use an instance RAM role`);
  }

  const [[, database]] = resourcesOfType(template, 'ALIYUN::RDS::DBInstance');
  assert(database.Properties.DBInstanceClass === definition.database.class, `${prefix} database class drift`);
  assert(database.Properties.DBInstanceStorage === definition.database.storage, `${prefix} database storage drift`);
  assert(database.Properties.BackupRetentionPeriod === definition.database.backupRetentionDays, `${prefix} database retention drift`);
  assert(database.Properties.InstanceNetworkType === 'VPC', `${prefix} database must use VPC networking`);
  assert(database.Properties.DBInstanceNetType === 'Intranet', `${prefix} database must use an intranet endpoint`);
  assert(database.Properties.AllocatePublicConnection === false, `${prefix} database must not allocate a public endpoint`);
  assert(isRef(database.Properties.MasterUserPassword, 'DatabaseCredentialRef'), `${prefix} database credential must come from the encrypted reference`);
  assert(database.DeletionPolicy === 'Retain', `${prefix} database must survive stack deletion by default`);

  const [[, cache]] = resourcesOfType(template, 'ALIYUN::REDIS::Instance');
  assert(cache.Properties.InstanceClass === definition.cache.class, `${prefix} cache class drift`);
  assert(cache.Properties.VpcPasswordFree === false, `${prefix} cache must not enable password-free VPC access`);
  assert(cache.Properties.SSLEnabled === 'Enable' && cache.Properties.TLSProtocol === 'TLSv1.2', `${prefix} cache must require TLS 1.2`);
  assert(isRef(cache.Properties.Password, 'CacheCredentialRef'), `${prefix} cache credential must come from the encrypted reference`);
  assert(cache.DeletionPolicy === 'Retain', `${prefix} cache must survive stack deletion by default`);

  const [[, bucket]] = resourcesOfType(template, 'ALIYUN::OSS::Bucket');
  assert(bucket.Properties.RedundancyType === definition.objectStorage.redundancy, `${prefix} OSS redundancy drift`);
  assert(bucket.Properties.AccessControl === 'private' && bucket.Properties.BlockPublicAccess === true, `${prefix} OSS must block public access`);
  assert(bucket.Properties.VersioningConfiguration?.Status === 'Enabled', `${prefix} OSS versioning must be enabled`);
  assert(bucket.Properties.ServerSideEncryptionConfiguration?.SSEAlgorithm === 'KMS', `${prefix} OSS must use KMS encryption`);

  const [[, key]] = resourcesOfType(template, 'ALIYUN::KMS::Key');
  assert(key.Properties.KeySpec === 'Aliyun_AES_256', `${prefix} KMS key must use AES-256`);
  assert(key.Properties.EnableAutomaticRotation === true && key.Properties.DeletionProtection === true, `${prefix} KMS key must enable rotation and deletion protection`);

  for (const [name, ingress] of resourcesOfType(template, 'ALIYUN::ECS::SecurityGroupIngress')) {
    const publicSource = ['0.0.0.0/0', '::/0'].includes(ingress.Properties.SourceCidrIp);
    if (publicSource) {
      assert(['80/80', '443/443'].includes(ingress.Properties.PortRange), `${prefix}.${name} exposes a forbidden public port`);
    }
    assert(ingress.Properties.PortRange !== '22/22' && ingress.Properties.PortRange !== '3389/3389', `${prefix}.${name} must not expose an administration port`);
  }

  for (const output of Object.keys(template.Outputs)) {
    const normalized = normalizeOutputName(output);
    assert(contract.outputs.allowed.includes(normalized), `${prefix} contains undeclared output ${output}`);
    assert(!forbiddenField.test(output), `${prefix} output is secret-like: ${output}`);
  }
}

const contract = await readJson(contractPath);
const definitions = await readJson(definitionsPath);
assert(contract.format === 'otto-aliyun-compute-nest-contract-v1', 'unsupported contract format');
assert(definitions.format === 'otto-aliyun-plan-definitions-v1', 'unsupported plan definition format');
assert(definitions.templateVersion === contract.templateVersion, 'plan definition and contract versions must match');
assert(contract.realDeploymentEnabled === false, 'local contract must not enable real cloud deployment');
assert(Array.isArray(contract.supportedRegions) && contract.supportedRegions.length > 0, 'supported regions are required');
assert(isObject(contract.plans), 'plans are required');
assert(isObject(contract.templates?.files), 'template file map is required');
for (const planName of ['trial', 'standard', 'ha']) {
  const plan = contract.plans[planName];
  const definition = definitions.plans[planName];
  assert(isObject(plan), `${planName} plan is required`);
  assert(isObject(definition), `${planName} plan definition is required`);
  assert(plan.availabilityZones >= 1 && plan.statelessServers >= 1, `${planName} capacity is invalid`);
  assert(plan.availabilityZones === definition.availabilityZones, `${planName} availability-zone definition drift`);
  assert(plan.statelessServers === definition.statelessServers, `${planName} server definition drift`);
  assert(path.basename(contract.templates.files[planName]) === definition.templateFile, `${planName} template filename drift`);
  for (const service of ['postgres', 'tair', 'oss']) {
    assert(isObject(plan[service]), `${planName}.${service} is required`);
    assert(plan[service].public === false, `${planName}.${service} must be private`);
  }
  assert(plan.oss.versioning === true && plan.oss.sseKms === true, `${planName}.oss must use versioning and KMS encryption`);
  const templatePath = path.resolve(root, contract.templates.files[planName]);
  validateTemplate(contract, planName, await readJson(templatePath), plan, definition);
}
assert(contract.network.tls.httpsRequired === true && contract.network.tls.minimumVersion === '1.2', 'TLS must be HTTPS with TLS 1.2 minimum');
assert(JSON.stringify(contract.network.publicPorts) === '[443]', 'only 443 may be public');
assert(contract.network.ssh.defaultEnabled === false, 'SSH must default to disabled');
assert(contract.secrets.plaintextAllowed === false && contract.secrets.missingDependencyAction === 'fail-closed', 'secrets must fail closed');
assert(contract.idempotency.replayMustNotCreateResources === true, 'replays must not create resources');
assert(Array.isArray(contract.idempotency.requiredFields) && contract.idempotency.requiredFields.includes('idempotencyKey'), 'idempotency key is required');
assert(contract.evidence.realCloudRunRequiredForCompletion === true, 'real cloud evidence requirement must remain explicit');
for (const listPath of [contract.parameters.allowed, contract.parameters.systemManaged, contract.parameters.forbidden, contract.outputs.allowed, contract.outputs.forbidden]) {
  assert(Array.isArray(listPath), 'contract field lists must be arrays');
}
for (const entry of [...contract.parameters.allowed, ...contract.outputs.allowed]) {
  assert(!forbiddenField.test(entry), `plaintext or secret-like field is allowed: ${entry}`);
}
for (const [from, destinations] of Object.entries(contract.states.transitions)) {
  assert(Array.isArray(destinations) && destinations.length > 0, `state ${from} has no transitions`);
  for (const destination of destinations) assert(destination in contract.states.transitions, `unknown state ${destination}`);
}
assert(contract.states.initial in contract.states.transitions, 'initial state is unknown');
for (const terminal of contract.states.terminal) assert(contract.states.transitions[terminal], `terminal state ${terminal} is unknown`);
console.log(`[aliyun-contract] valid: ${contract.templateVersion}; templates=3; realDeploymentEnabled=${contract.realDeploymentEnabled}`);
