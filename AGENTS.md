# Family Frame agent instructions

Follow the global agent contract in `~/DEV/AGENTS.md`.

## Primary interfaces

The native iOS app and physical frame are the household's primary interfaces. For every requested feature, fix, or interface change, assess its impact on both. Implement the relevant iOS changes as part of the same task without requiring a separate request; a web-only implementation is incomplete when the behavior also applies to iOS. Preserve each interface's appropriate native interaction patterns and shared server contracts.

Validate the affected iOS behavior with proportional checks. When an iOS change requires a new app build, follow the signing and distribution instructions in `ios/README.md` and report source merge, build validation, distribution, and device verification separately. A merged change does not mean the installed app has been updated. Surface any delivery blocker explicitly.
