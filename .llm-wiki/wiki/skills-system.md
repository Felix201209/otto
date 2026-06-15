---
type: entity
date: 2026-04-09
tags: [class, core, skills, marketplace, plugin]
sources: [raw/02-core-module.md]
---

# Skills System

> Pluggable skill modules for specialized workflows.

## Overview

Skills 系统提供完整的插件市场架构，包括技能加载、安装、上下文注入和脚本执行。

## Components

| Component | Role |
|-----------|------|
| [[SkillLoader]] | Loads skill modules |
| [[MarketplaceManager]] | Marketplace management |
| PluginInstaller | Skill installation |
| ScriptExecutor | Script execution for skills |
| SkillContextInjector | Context injection into prompts |

## Tools

- `list_available_skills` — list installed/enabled skills
- `get_skill_details` — get skill info
- `use_skill` — activate a skill

## Location

`packages/core/src/skills/`

## Related

- [[core-module]]
- [[tools-system]] — skills tools
- [[cli-module]] — initialized during bootstrap
