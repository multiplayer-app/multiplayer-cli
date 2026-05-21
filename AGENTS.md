# Multiplayer CLI Development Guidelines

## Project Overview

This is **multiplayer**, a command-line utility for working with Multiplayer. It's primarily written in **JavaScript/Node.js**.

## Language & Architecture

- **Primary language**: JavaScript/TypeScript (npm wrapper, installation scripts)
- **Build system**: npm/yarn for JavaScript
- **Cross-platform**: Supports multiple architectures (darwin, linux, windows, ARM variants)
- **Binary distributions**: Located in `npm-binary-distributions/` for different platforms

## Project Structure

- `src/` - Core JavaScript/TypeScript source code with command modules and utilities
- `scripts/` - Build and utility scripts
- `dist/` - Platform-specific binary packages
- `bin/` - Contains entry js file
- `.github/workflows/` - CI/CD workflows (follows reusable workflow pattern)

## Development Standards

### Commit Message Format

**MUST follow Multiplayer's commit message format**: `type(scope): subject`

Valid types: `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `ref`, `style`, `test`, `meta`, `license`, `revert`

Subject requirements:

- Capitalize first letter
- Use imperative mood ("Add" not "Added")
- No trailing period
- Max 70 characters for header

### Performance & Scale Considerations

- CLI tool should be fast and responsive
- Consider impact on cold start times
- Memory usage matters for CI environments
- Network operations should be optimized and retryable

### Security Best Practices

- Handle authentication tokens securely
- Validate file paths to prevent directory traversal
- Consider impact of processing user-provided files (sourcemaps, debug files)
- Follow Typescript security best practices

## Testing Requirements

- Cross-platform testing via CI matrix

## Code Formatting

**ALWAYS** run `npm run lint -- --fix` before committing any JavaScript/TypeScript code changes to ensure consistent formatting across the codebase.

## Updating These Guidelines

Update AGENTS.md files when you encounter **generally applicable** patterns:
- Development patterns and best practices
- Common pitfalls and architecture decisions
- Workflow improvements and tool configurations

**Do NOT capture**: Task-specific fixes, temporary workarounds, personal preferences.

**Keep AGENTS.md files as concise as possible to minimize token usage.**

---

Remember: This is a production tool used by many developers. Changes should be well-tested, backward-compatible, and follow established patterns.
