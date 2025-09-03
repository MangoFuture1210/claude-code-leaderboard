# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `npm install` - Install all dependencies
- `npm start` or `node bin/cli.js` - Run the CLI tool
- `npm run dev` - Development mode (same as npm start)
- `npm run local-auth` - Test authentication flow locally
- `npm run local-stats` - Test stats command locally  
- `npm run local-leaderboard` - Test leaderboard command locally

### Testing & Publishing
- `npm run pack-test` - Build and install the package globally for testing
- `npm run unpack-test` - Uninstall the global test package
- `npm version patch` - Bump patch version for release
- `npm publish` - Publish to npm registry

## Architecture

### Core Components

**CLI Entry Point** (`bin/cli.js`)
- Main command handler using Commander.js
- Handles authentication, reset, and help commands
- Performs auto-reset checks for version upgrades
- Ensures hook installation before any command execution

**Hook System** (`hooks/count_tokens.js`)
- Standalone Node.js script executed after Claude Code sessions
- Scans Claude projects for `.jsonl` usage files
- Extracts token usage statistics (input, output, cache tokens)
- Sends data to API endpoint with deduplication via interaction hashes
- Must maintain CLI_VERSION constant matching package.json version

**Authentication Flow** (`src/auth/`)
- OAuth 1.0a implementation for Twitter authentication
- Local Express server for callback handling
- Token storage in `~/.claude/leaderboard.json`
- Auto-migration and version upgrade handling

**Configuration Management** (`src/utils/config.js`)
- Manages user configuration in `~/.claude/leaderboard.json`
- Handles OAuth token encryption/decryption
- Provides auth status checking

### Key Design Patterns

1. **Version Management**: CLI_VERSION constant in hook must match package.json version for API compatibility
2. **Automatic Hook Updates**: Hook script auto-updates when new version detected
3. **Silent Failures**: Hook operates silently, never blocking Claude Code operations
4. **Deduplication**: Uses SHA256 hashes of interaction data to prevent duplicate submissions

### File Installation Locations
- `~/.claude/count_tokens.js` - The hook script
- `~/.claude/settings.json` - Claude Code settings with hook registration
- `~/.claude/leaderboard.json` - User authentication and API configuration
- `~/.claude/package.json` - Minimal package.json for ES module support

### API Integration
- Base URL: `https://api.claudecount.com`
- Endpoints:
  - `/api/usage/hook` - Submit usage data from hook
  - `/api/auth/oauth1a/*` - OAuth authentication flow
  - `/api/users/*` - User management
- Version checking via `X-CLI-Version` header
- HTTP 426 response triggers CLI upgrade requirement

### Error Handling
- Hook failures exit silently (exit code 0) to avoid blocking Claude Code
- Version mismatches exit with code 2 to block Claude Code execution
- Network timeouts set to 10 seconds for API calls
- Authentication failures provide helpful troubleshooting tips