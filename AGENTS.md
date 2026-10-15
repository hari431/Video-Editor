# Agent instructions

`.ai/README.md` is the project's source of truth for the development workflow.

Before any work, read `.ai/README.md`, then follow the relevant guidance in
`.ai/agents/` (implementer, debugger, reviewer, verifier) and
`.ai/skills/` (implementation-planning, systematic-debugging, code-review,
security-review, completion-verification).

Binding loop: one change → verify → report → wait for approval.
No silent scope expansion. No completion claim without evidence.
