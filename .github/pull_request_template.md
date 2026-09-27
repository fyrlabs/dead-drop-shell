## What changes

<!-- What the change does and why. Describe the behaviour as it now is. -->

## Breaking changes

<!-- Protocol (shell.v1), config schema, CLI flags and exported types are public surface. Write "None" if nothing breaks. -->

None.

## Testing

- [ ] `npm run verify` passes
- [ ] New or changed behaviour has a test that fails without the change
- [ ] Anything touching delivery (duplicates, restarts, timeouts) has a test proving a command does not run twice

## Checklist

- [ ] Commits follow `type(scope): subject`
- [ ] Docs updated if behaviour, config or CLI changed
- [ ] `CHANGELOG.md` updated under Unreleased if user-visible
- [ ] No secrets, tokens, command text in logs, or absolute local paths in the diff
