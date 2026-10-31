---
name: principle-paved-path
description: "Follow the paved path, and extend a pattern only when you'd want it copied again. Use before copying or extending existing code as the model for new code, and before writing a workaround or a comment that explains one."
---

# Paved path

Agents copy what they see, so every pattern you extend becomes the template for the next agent. One workaround copied for a few days ends up everywhere. The paved path is the way the codebase means you to do things, as its docs, lint rules and best-kept code show it.

- Extend a pattern only when you'd want it copied again.
- Fix the cause in your own code. A workaround you write, and the comment that defends it, teach the next agent to keep it.
- When the nearest example is a workaround, follow the paved path instead, and list the example as a followup. Fix it here only when your change can't work without fixing it.
