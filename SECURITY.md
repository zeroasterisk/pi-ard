# Security

## Reporting
Use GitHub private vulnerability reporting (Security tab → "Report a vulnerability"), or email alan@zeroasterisk.com. Please don't open public issues for vulnerabilities. Expect an acknowledgement within 5 business days.

## Threat model (what pi-ard defends, what it doesn't)

pi-ard moves third-party content (registry results, SKILL.md files, MCP server cards) into an agent that has your permissions. Its job is to make sure nothing is installed or run without a human decision based on accurate information.

**Defended**
- **Model-initiated installs without consent.** Every write or registration goes through Pi's `ctx.ui.confirm`. No tool argument skips it, and with no UI the install is refused.
- **Fabricated entries.** `ard_install` accepts only identifiers that a registry returned in this session.
- **Misleading identity.** A `trustManifest.identity` outside the publisher's domain is refused (ARD §4.5.1). Lookalike domains (`badexample.com` vs `example.com`) don't match trusted domains.
- **Transport.** HTTPS only (loopback excepted). No URL credentials. No cross-host redirects. No POST redirects. Timeouts and size caps apply.
- **Path traversal.** Skill names must match `^[a-z0-9]+(-[a-z0-9]+)*$`. Existing skills are never overwritten.
- **Project-level hijack.** Config is read from the user's agent dir only, never from the working directory.

**Not defended (known gaps)**
- **Signature or attestation verification.** It is not implemented, because ARD v0.91 delegates it to trust frameworks that are not finalized. pi-ard shows declared attestation types and labels them "signature and attestations NOT verified".
- **Malicious content from a trusted domain.** Trust means only that the owner allowlisted the domain. Review the SKILL.md after install.
- **Prompt injection in descriptions.** Output labels descriptions as third-party data, but a model can still be influenced by them. The confirm step is the backstop.
- **What an MCP server does after you add it.** That is Pi's MCP runtime and the server's own responsibility.
