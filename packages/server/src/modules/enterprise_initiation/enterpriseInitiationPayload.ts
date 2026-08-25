/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface EnterpriseInitiationPayload {
  organization: {
    id: string;
    name: string;
    slug?: string;
  };
  ceo: {
    username: string;
    name: string;
    phone: string;
  };
  defaultDepartmentName: string;
  modules: string[];
}

const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;
const CEO_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const MAINLAND_PHONE = /^(?:\+86)?1[3-9]\d{9}$/u;

function strictObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_invalid`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new Error(`${label}_unknown_field`);
  }
  return object;
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`${label}_invalid`);
  return text;
}

/** Parse the signed enterprise.initiate business payload fail closed. */
export function parseEnterpriseInitiationPayload(
  value: unknown,
): EnterpriseInitiationPayload {
  const root = strictObject(value, 'payload', [
    'organization',
    'ceo',
    'defaultDepartmentName',
    'modules',
  ]);
  const organization = strictObject(root.organization, 'organization', [
    'id',
    'name',
    'slug',
  ]);
  const ceo = strictObject(root.ceo, 'ceo', ['username', 'name', 'phone']);

  const organizationId = requiredText(organization.id, 'organization_id', 160);
  if (!ORGANIZATION_ID.test(organizationId)) {
    throw new Error('organization_id_invalid');
  }
  const organizationName = requiredText(
    organization.name,
    'organization_name',
    80,
  );
  const slug =
    organization.slug === undefined
      ? undefined
      : requiredText(
          organization.slug,
          'organization_slug',
          48,
        ).toLocaleLowerCase('en-US');
  if (slug !== undefined && !ORGANIZATION_SLUG.test(slug)) {
    throw new Error('organization_slug_invalid');
  }

  const username = requiredText(ceo.username, 'ceo_username', 64);
  if (!CEO_USERNAME.test(username)) throw new Error('ceo_username_invalid');
  const ceoName = requiredText(ceo.name, 'ceo_name', 80);
  const phone = requiredText(ceo.phone, 'ceo_phone', 14).replace(/[\s-]/gu, '');
  if (!MAINLAND_PHONE.test(phone)) throw new Error('ceo_phone_invalid');

  const defaultDepartmentName = requiredText(
    root.defaultDepartmentName,
    'default_department_name',
    80,
  );
  if (
    !Array.isArray(root.modules) ||
    root.modules.length === 0 ||
    root.modules.length > 64
  ) {
    throw new Error('modules_invalid');
  }
  const modules = root.modules.map((moduleId) =>
    requiredText(moduleId, 'module', 80),
  );

  return {
    organization: {
      id: organizationId,
      name: organizationName,
      ...(slug === undefined ? {} : { slug }),
    },
    ceo: {
      username,
      name: ceoName,
      phone: phone.startsWith('+86') ? phone : `+86${phone}`,
    },
    defaultDepartmentName,
    modules: [...new Set(modules)],
  };
}
