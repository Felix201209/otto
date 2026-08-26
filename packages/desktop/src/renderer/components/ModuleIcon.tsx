/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

import {
  GeneratedIcon,
  GENERATED_ICON_NAMES,
  type GeneratedIconName,
} from './GeneratedIcon.js';
import {
  IconAgent,
  IconBrain,
  IconCar,
  IconClipboardCheck,
  IconClipboardList,
  IconCreditCard,
  IconDashboard,
  IconDoorOpen,
  IconHammer,
  IconHistory,
  IconMegaphone,
  IconParking,
  IconPhone,
  IconRepair,
  IconStore,
  IconTerminal,
  IconWand,
  OttoAvatar,
} from './icons.js';

const MODULE_LINE_ICON_REGISTRY = {
  'park-overview': IconDashboard,
  'park-announcement': IconMegaphone,
  'park-satisfaction': IconClipboardCheck,
  'park-renovation': IconHammer,
  'park-parking': IconParking,
  'park-network-phone': IconPhone,
  'park-meeting-room': IconDoorOpen,
  'park-electric-card': IconCreditCard,
  'park-repair': IconRepair,
  'park-vehicle-visit': IconCar,
  'park-staff-tasks': IconClipboardList,
  'park-my-applications': IconHistory,
  'enterprise-memory': IconBrain,
  'auto-skill': IconWand,
  'skill-zone': IconStore,
  agent: IconAgent,
  'self-development': IconTerminal,
} as const;

export const MODULE_LINE_ICON_KEYS = Object.freeze(
  Object.keys(MODULE_LINE_ICON_REGISTRY) as ModuleLineIconKey[],
);

export type ModuleLineIconKey = keyof typeof MODULE_LINE_ICON_REGISTRY;
export type ModuleIconKey =
  | ModuleLineIconKey
  | `generated:${GeneratedIconName}`
  | 'otto-avatar'
  | 'custom-agent';

function isGeneratedIconName(value: string): value is GeneratedIconName {
  return (GENERATED_ICON_NAMES as readonly string[]).includes(value);
}

function isGeneratedModuleIcon(
  value: ModuleIconKey,
): value is `generated:${GeneratedIconName}` {
  return value.startsWith('generated:');
}

export function hasModuleIcon(value: string): value is ModuleIconKey {
  if (value === 'otto-avatar' || value === 'custom-agent') return true;
  if (value in MODULE_LINE_ICON_REGISTRY) return true;
  if (!value.startsWith('generated:')) return false;
  return isGeneratedIconName(value.slice('generated:'.length));
}

export interface ModuleIconProps {
  icon: ModuleIconKey;
  label: string;
  size?: number;
  className?: string;
}

export function ModuleIcon({
  icon,
  label,
  size = 28,
  className,
}: ModuleIconProps): React.JSX.Element {
  const wrapperClassName = ['otto-module-icon', className].filter(Boolean).join(' ');
  if (isGeneratedModuleIcon(icon)) {
    const generatedName = icon.slice('generated:'.length) as GeneratedIconName;
    return (
      <span className={wrapperClassName} data-module-icon={icon} aria-hidden>
        <GeneratedIcon name={generatedName} size={size} />
      </span>
    );
  }
  if (icon === 'otto-avatar') {
    return (
      <span className={wrapperClassName} data-module-icon={icon} aria-hidden>
        <OttoAvatar size={size} />
      </span>
    );
  }
  if (icon === 'custom-agent') {
    return (
      <span className={`${wrapperClassName} otto-module-icon--custom`} data-module-icon={icon} aria-hidden>
        {Array.from(label.trim())[0] || '专'}
      </span>
    );
  }
  const Icon = MODULE_LINE_ICON_REGISTRY[icon];
  return (
    <span className={wrapperClassName} data-module-icon={icon} aria-hidden>
      <Icon size={size} />
    </span>
  );
}
