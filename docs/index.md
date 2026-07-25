# Welcome to Otto Documentation

This documentation provides a guide to developing and delivering Otto. Otto is a desktop-first AI assistant with shared core, local server, enterprise services, and componentized skills.

## Overview

Otto is a monorepo project consisting of:
- **`packages/core`**: Core functionality library (AI client, tools, MCP, hooks, skills)
- **`packages/server`**: Local and enterprise HTTP/WebSocket services
- **`packages/desktop`**: Electron desktop client and renderer

Desktop and server code communicate through the core library, which manages requests, tool execution, context handling, and extensibility features.

---

## 📚 Documentation Index

### 🚀 Getting Started
- **[Architecture Overview](./architecture.md)** - High-level system design and component interactions
- **[Uninstall Guide](./Uninstall.md)** - How to remove Otto

### 🔧 Core Library Documentation
- **[Core Introduction](./core/index.md)** - Overview of the core package
- **[Tools API](./core/tools-api.md)** - Tool system architecture and APIs
- **[Memport](./core/memport.md)** - Memory management port
- **[Agent Runtime Engineering Wiki](./agent-runtime-engineering-wiki.md)** - Model-neutral engineering contract for mature agent runtime behavior

### 🛠️ Tools Documentation
- **[Tools Overview](./tools/index.md)** - Available tools and their purposes
- **[File System Tools](./tools/file-system.md)** - `read_file`, `write_file` operations
- **[Multi-File Read Tool](./tools/multi-file.md)** - `read_many_files` functionality
- **[Shell Tool](./tools/shell.md)** - `run_shell_command` usage
- **[Web Fetch Tool](./tools/web-fetch.md)** - `web_fetch` for HTTP requests
- **[Web Search Tool](./tools/web-search.md)** - `google_web_search` integration
- **[Memory Tool](./tools/memory.md)** - `save_memory` for context persistence
- **[MCP Server Tool](./tools/mcp-server.md)** - Model Context Protocol integration
- **[Refine Command](./tools/refine-command.md)** - Code refinement utilities

### 🪝 Hooks System (Enterprise Features)
- **[🎯 START HERE: Hooks Overview](./HOOKS_START_HERE.md)** - **Main entry point for Hooks system**
- **[Hooks Index](./HOOKS_INDEX.md)** - Complete Hooks documentation index
- **[Hooks User Guide](./hooks-user-guide.md)** - How to create and use hooks
- **[Hooks Examples](./hooks-examples.md)** - Ready-to-use hook scripts
- **[Hooks Implementation](./hooks-implementation.md)** - Technical implementation details
- **[Hooks Architecture](./HOOKS_ARCHITECTURE.md)** - System architecture and design
- **[Hooks Delivery Summary](./HOOKS_DELIVERY_SUMMARY.md)** - Project delivery overview
- **[Hooks Implementation Summary](./HOOKS_IMPLEMENTATION_SUMMARY.md)** - Implementation milestones
- **[Hooks Final Summary](./HOOKS_FINAL_SUMMARY.md)** - Complete feature summary
- **[Hook Setup Instructions](./hook-setup-instructions-for-end-users.md)** - End-user setup guide

### 🎯 Skills System
- **[Skills Usage Guide](./skills-usage.md)** - How to use and create skills

### 🔌 Model Context Protocol (MCP)
- **[MCP Sequential Startup](./mcp-sequential-startup.md)** - Server startup ordering
- **[MCP Tools Sync Fix](./mcp-tools-sync-fix.md)** - Tool synchronization fixes
- **[MCP Response Guard](./mcp-response-guard.md)** - Response validation system
- **[MCP Response Guard Integration](./mcp-response-guard-integration-guide.md)** - Integration guide
- **[Cloud Mode MCP Fix](./cloud-mode-mcp-fix.md)** - Cloud deployment fixes

### 🔤 Language Server Protocol (LSP)
- **[LSP Usage Guide](./LSP_USAGE_GUIDE.md)** - LSP integration and usage

### 🏗️ Build & Development
- **[Build Workflow](./build-workflow.md)** - Build process and scripts
- **[Release Preflight](./release-preflight.md)** - Mandatory release checklist and gates
- **[NPM Workspaces](./npm.md)** - Monorepo package management
- **[NPM Publish Guide](./npm-publish-guide.md)** - Publishing packages to npm
- **[GitHub Actions Release](./github-actions-release.md)** - CI/CD release automation
- **[Integration Tests](./integration-tests.md)** - End-to-end testing
- **[Environment Configuration](./environment-configuration.md)** - Environment setup

### 🎨 UI/UX Features & Optimizations
- **[Inline Completion Feature](./inline-completion-feature.md)** - AI-powered code suggestions
- **[Input Performance Optimization](./input-performance-optimization.md)** - Input handling improvements
- **[Input Width Optimization](./input-width-optimization.md)** - Responsive input sizing
- **[Input Height Auto-Resize](./input-height-auto-resize-bug-fix.md)** - Dynamic textarea resizing
- **[Footer Responsive Optimization](./footer-responsive-optimization.md)** - Footer layout improvements
- **[Small Window Optimization](./small-window-optimization.md)** - Small screen adaptations
- **[Theme Dialog Optimization](./theme-dialog-small-window-optimization.md)** - Theme selector for small windows
- **[Long Text Display Optimization](./long-text-display-optimization.md)** - Text rendering improvements
- **[Horizontal Confirmation Layout](./horizontal-confirmation-layout.md)** - Confirmation dialog layout
- **[Terminal Interaction Optimization](./terminal-interaction-optimization.md)** - Terminal UX improvements
- **[Paste Text Handling](./paste-text-handling.md)** - Clipboard integration
- **[VS Code Hotkey Conflicts](./vscode-hotkey-conflicts.md)** - Hotkey conflict resolution

### 🔐 Security & Authentication
- **[Auth Lazy Refresh](./auth-lazy-refresh.md)** - Optimized token refresh strategy
- **[Token Refresh Threshold](./token-refresh-threshold-optimization.md)** - Token refresh timing
- **[Custom Proxy Server Priority](./custom-proxy-server-priority.md)** - Enterprise proxy configuration

### 📦 Platform & Compatibility
- **[Cross-Platform Binary Fix](./cross-platform-binary-fix.md)** - Multi-platform binary support
- **[SSH/WSL Compatibility](./ssh-wsl-compatibility.md)** - Remote development support
- **[Ubuntu Clipboard Support](./ubuntu-clipboard-support.md)** - Linux clipboard integration
- **[TSX/JSX File Type Support](./tsx-jsx-file-type-support.md)** - React file handling
- **[Supported File Types](./supported-file-types.md)** - Complete file format support
- **[DTS Robust Detection](./dts-robust-detection-strategy.md)** - TypeScript declaration detection

### 🧪 Testing & Quality
- **[Background Tasks Quick Reference](./BACKGROUND_TASKS_QUICK_REFERENCE.md)** - Async task management

### 📊 Monitoring & Telemetry
- **[Telemetry](./telemetry.md)** - Usage analytics and monitoring
- **[Startup Performance Summary](./startup-performance-summary.md)** - Performance metrics

### ⚙️ Advanced Features
- **[Checkpointing](./checkpointing.md)** - Session state saving/restoration
- **[Extensions System](./extension.md)** - CLI extensibility framework
- **[Custom Rules Management](./custom-rules-management.md)** - User-defined coding rules
- **[Empty Session Cleanup](./empty-session-cleanup.md)** - Session lifecycle management
- **[Plan Mode Exit Notification](./plan-mode-exit-notification.md)** - Plan mode UX
- **[Remote Server Analysis](./remote-server-analysis.md)** - Remote deployment analysis
- **[Sandbox](./sandbox.md)** - Sandboxed execution environment

### 📖 Legal & Policies
- **[Terms of Service & Privacy](./tos-privacy.md)** - Legal terms and privacy policy
- **[Quota and Pricing](./quota-and-pricing.md)** - Usage limits and pricing

### 🤝 Contributing
- **[Contributing Guide](../CONTRIBUTING.md)** - How to contribute to Otto
- **[Project Knowledge Base](../EASYCODE.md)** - Core project information for AI assistants

### 📝 Examples
- **[Proxy Script Example](./examples/proxy-script.md)** - Custom proxy configuration example
- **[Rules Examples](./examples/rules/)** - Custom rules examples

---

## 🗂️ Documentation Organization

This documentation is structured into logical sections:

1. **Getting Started** - For new users and installation
2. **CLI** - Command-line interface specifics
3. **Core** - Core library internals
4. **Tools** - Individual tool documentation
5. **Hooks** - Enterprise hooks system (security & extensibility)
6. **Skills** - Reusable AI workflows
7. **MCP** - Model Context Protocol integration
8. **LSP** - Language Server Protocol features
9. **Build** - Development and deployment
10. **UI/UX** - User interface optimizations
11. **Security** - Authentication and security features
12. **Platform** - Cross-platform compatibility
13. **Advanced** - Advanced features and customization

---

## 💡 Quick Navigation Tips

- **New to Otto?** Start with [Deployment Guide](./deployment.md)
- **VS Code User?** See [VS Code Extension Documentation](../packages/vscode-ui-plugin/README.md)
- **Enterprise Admin?** Read [Hooks START HERE](./HOOKS_START_HERE.md)
- **Developer/Contributor?** See [Contributing Guide](../CONTRIBUTING.md) and [Architecture](./architecture.md)
- **Need MCP Integration?** Check [MCP Documentation](#-model-context-protocol-mcp)
- **Troubleshooting?** Visit [Troubleshooting Guide](./troubleshooting.md)

---

We hope this documentation helps you make the most of Otto! 🚀
